"""本地票据任务：限定目录查找、识别、待审核清单、显式确认入账。"""
from __future__ import annotations

import hashlib
import json
import os
import re
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..config import PROJECT_DIR, UPLOAD_DIR, settings
from ..database import SessionLocal, get_db
from ..models import AgentTask, Invoice, InvoiceFile, ProcessingJob, new_id
from ..schemas import InvoiceOut, invoice_to_dict
from ..services.pipeline import create_ledger_entry, process_file, recount_job
from ..services.storage import TYPE_MAP, count_pages, safe_filename, save_upload, sha256_of, validate_upload
from ..services.validate import validate_invoice
from ..services.task_scope import TaskScope, source_root, extract_dates

SOURCE_ROOT = PROJECT_DIR / "素材"
MAX_FILES = 50
MAX_ENTRIES = 5000
worker_lock = threading.Lock()


def local_request(request: Request):
    # 本地文件权限不应被第三方网页或远程客户端调用。
    if request.client and request.client.host not in {"127.0.0.1", "::1", "testclient"}:
        raise HTTPException(403, "本地查找仅允许从本机使用")
    from urllib.parse import urlparse
    origin = request.headers.get("origin")
    if origin and urlparse(origin).hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise HTTPException(403, "不允许外部网页访问本地票据")
    if request.url.hostname not in {"localhost", "127.0.0.1", "::1", "testserver"}:
        raise HTTPException(403, "无效的本地主机名")


router = APIRouter(prefix="/agent", tags=["本地 Agent"], dependencies=[Depends(local_request)])


class TaskIn(BaseModel):
    prompt: str = Field(min_length=1, max_length=500)
    source_dir: str | None = None


class ConfirmTaskIn(BaseModel):
    invoice_ids: list[str] = Field(min_length=1, max_length=50)
    revisions: dict[str, str]


def parse_plan(prompt: str, now: datetime | None = None) -> dict:
    """有界语言解析；未理解的约束必须报错，绝不扩大为全部文件。"""
    now = now or datetime.now(timezone(timedelta(hours=8)))
    text = prompt.strip()
    keywords = re.findall(r'[“"「]([^”"」]+)[”"」]', text)
    rest = re.sub(r'[“"「][^”"」]+[”"」]', '', text)
    try:
        rest, dates = extract_dates(rest, now)
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    for word in ['办公用品', '技术服务', '云服务', '住宿', '餐饮', '运输', '加油', '差旅', '软件']:
        if word in rest:
            keywords.append(word)
            rest = rest.replace(word, '')
    for word in sorted(['帮我', '请', '把', '整理一下', '整理', '查找', '找到', '查找并', '导入', '台账', '账本', '给我过目', '过目', '审核', '确认后', '然后', '最后', '并', '导出', '发票', '票据', '所有', '全部', '本地', '素材文件夹', '素材', '文件夹', '目录', '里面', '里', '中的', '的', '有关', '包含', '关于', '相关'], key=len, reverse=True):
        rest = rest.replace(word, '')
    rest = re.sub(r'[\s，。；、,;：:！!]+', '', rest)
    if rest:
        raise HTTPException(422, f"暂时无法可靠理解「{rest}」。请用例如：整理2026年9月包含“公司名”的发票。公司名或项目名请加引号；暂不支持金额区间、排除条件或复杂逻辑条件。")
    if not any(word in text for word in ['发票', '票据']):
        raise HTTPException(422, "请说明要整理的发票，例如：整理素材里的全部发票。")
    return {"prompt": prompt, "root": str(SOURCE_ROOT), **dates,
            "keywords": list(dict.fromkeys(k.strip() for k in keywords if k.strip())),
            "limit": MAX_FILES, "mode": "local_rules",
            "description": "按票面开票月份筛选；关键词同时匹配购销双方、项目明细或票面备注。不会修改票面日期。"}


def normal(text):
    return re.sub(r'\s+', '', str(text or '')).casefold()


def matches(invoice: Invoice, plan: dict) -> tuple[str, str]:
    if not invoice.invoice_number or not invoice.seller_name:
        return "uncertain", "票面信息不足，需要核对是否属于本次任务"
    if plan.get("month") or plan.get('months') or plan.get('date_from') or plan.get('date_to'):
        if not invoice.invoice_date:
            return "uncertain", "开票日期缺失，无法判断月份"
        if plan.get('month') and not invoice.invoice_date.startswith(plan['month']):
            return "excluded", "票面开票月份不符合要求"
        if plan.get('months') and invoice.invoice_date[:7] not in plan['months']:
            return 'excluded', '票面开票月份不在所选月份中'
        if plan.get('date_from') and invoice.invoice_date < plan['date_from']:
            return 'excluded', '票面日期早于指定范围'
        if plan.get('date_to') and invoice.invoice_date > plan['date_to']:
            return 'excluded', '票面日期晚于指定范围'
    content = normal(' '.join([invoice.seller_name or '', invoice.buyer_name or '',
                              invoice.invoice_remark or '', *[i.item_name or '' for i in invoice.items]]))
    if any(normal(word) not in content for word in plan['keywords']):
        return "excluded", "识别后的票面字段不包含所需关键词，请核对识别结果"
    for field in ('buyer', 'seller'):
        if plan.get(field):
            actual = getattr(invoice, field + '_name')
            if not actual:
                return 'uncertain', '购销方信息缺失，请核对原票'
            if normal(plan[field]) not in normal(actual):
                return 'excluded', '购销方不符合本次条件'
    if plan.get('exclude_confirmed') and invoice.status == 'confirmed':
        return 'excluded', '按要求排除已入账票据'
    if plan.get('min_amount') is not None or plan.get('max_amount') is not None:
        if invoice.total_amount is None:
            return 'uncertain', '金额缺失，无法判断金额范围'
        if plan.get('min_amount') is not None and invoice.total_amount < plan['min_amount']:
            return 'excluded', '价税合计低于所需范围'
        if plan.get('max_amount') is not None and invoice.total_amount > plan['max_amount']:
            return 'excluded', '价税合计高于所需范围'
    return "matched", "识别后的票面信息符合本次条件"


def revision(invoice: Invoice) -> str:
    snapshot = InvoiceOut.model_validate(invoice_to_dict(invoice)).model_dump(mode='json')
    return hashlib.sha256(json.dumps(snapshot, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def task_or_404(db, task_id):
    task = db.get(AgentTask, task_id)
    if not task:
        raise HTTPException(404, "任务不存在")
    return task


def output(db, task):
    data = dict(task.payload)
    result = []
    seen = set()
    for record in data.get('records', []):
        item = dict(record)
        invoice = db.get(Invoice, item.get('invoice_id')) if item.get('invoice_id') else None
        if invoice:
            scope = dict(data['plan'])
            if invoice.id in data.get('confirmed_ids', []):
                scope['exclude_confirmed'] = False
            kind, reason = matches(invoice, scope)
            item.update(kind=kind, reason=reason, invoice=InvoiceOut.model_validate(invoice_to_dict(invoice)).model_dump(mode='json'), revision=revision(invoice))
            if invoice.id in seen:
                item.update(kind='duplicate', reason='本任务中相同文件已列出，复用同一记录')
            seen.add(invoice.id)
        elif item.get('invoice_id'):
            item.update(kind='failed', reason='票据已被删除')
        result.append(item)
    return {**data, 'id': task.id, 'status': task.status, 'records': result}


@router.get('/config')
def config():
    return {'root': str(SOURCE_ROOT), 'limit': MAX_FILES}


@router.post('/plan')
def plan(body: TaskIn):
    parsed = parse_plan(body.prompt)
    parsed['root'] = str(source_root(body.source_dir))
    return parsed


@router.post('/tasks')
def start(body: TaskIn, background: BackgroundTasks, db: Session = Depends(get_db)):
    parsed = parse_plan(body.prompt)
    parsed['root'] = str(source_root(body.source_dir))
    return start_plan(parsed, background, db)


def start_plan(parsed, background, db):
    parsed['root'] = str(source_root(parsed.get('root')))
    running = db.query(AgentTask).filter(AgentTask.status.in_(['queued', 'processing'])).first()
    if running:
        raise HTTPException(409, f'已有任务正在运行，请先等待完成：{running.id}')
    task = AgentTask(id=new_id(), status='queued', payload={'plan': parsed, 'records': [], 'log': ['任务已接收，等待扫描指定目录'], 'processed': 0, 'total': 0})
    db.add(task); db.commit()
    background.add_task(work, task.id)
    return output(db, task)


@router.get('/tasks/latest')
def latest(db: Session = Depends(get_db)):
    task = db.query(AgentTask).order_by(AgentTask.created_at.desc()).first()
    return output(db, task) if task else None


@router.get('/tasks/{task_id}')
def get_task(task_id: str, db: Session = Depends(get_db)):
    return output(db, task_or_404(db, task_id))


def save(db, task, data):
    task.payload = json.loads(json.dumps(data))
    db.commit()


def safe_source(path: Path, scope_root: Path | None = None) -> bool:
    scope_root = scope_root or SOURCE_ROOT
    root = scope_root.resolve()
    # 跳过符号链接、Windows junction 和其他重解析点，避免越出用户指定目录。
    try:
        if not path.absolute().is_relative_to(scope_root.absolute()):
            return False
        current = path
        while current != scope_root.parent:
            if current.is_symlink() or getattr(current.lstat(), 'st_file_attributes', 0) & 0x400:
                return False
            if current == scope_root:
                break
            current = current.parent
        return path.resolve().is_relative_to(root)
    except OSError:
        return False


def work(task_id):
    with worker_lock, SessionLocal() as db:
        task = db.get(AgentTask, task_id)
        if not task or task.status != 'queued':
            return
        data = dict(task.payload)
        try:
            root = source_root(data['plan']['root'])
            task.status = 'processing'
            save(db, task, data)
            candidates = []
            entries = 0
            limited = False
            scan_errors = []
            def scan_error(exc):
                scan_errors.append(f'目录无法读取：{exc.filename}')
            for folder, dirs, files in os.walk(root, followlinks=False, onerror=scan_error):
                dirs[:] = sorted(d for d in dirs if not d.startswith('.') and safe_source(Path(folder) / d, root))
                for name in sorted(files):
                    entries += 1
                    if entries > MAX_ENTRIES:
                        limited = True
                        break
                    path = Path(folder) / name
                    if path.suffix.lower() not in TYPE_MAP or not safe_source(path, root):
                        continue
                    if len(candidates) >= MAX_FILES:
                        limited = True
                        break
                    candidates.append(path)
                if limited:
                    break
            data['total'] = len(candidates)
            data['limited'] = limited
            data['log'] += scan_errors
            data['log'].append(f'找到 {len(candidates)} 个 PDF/图片候选文件，将按票面信息核对条件。')
            if limited:
                data['log'].append(f'已达到扫描上限（{MAX_FILES} 个候选 / {MAX_ENTRIES} 个文件），结果不完整，请缩小指定目录范围后再运行。')
            save(db, task, data)
            job = ProcessingJob(id=new_id(), status='processing', total=0, ocr_provider=settings.resolved_ocr_provider)
            db.add(job); db.commit()
            data['job_id'] = job.id
            for path in candidates:
                record = {'path': str(path.relative_to(root)), 'kind': 'failed', 'reason': ''}
                try:
                    if not safe_source(path, root) or path.stat().st_size > settings.max_file_size_bytes:
                        raise ValueError('文件超出大小限制或来源路径发生变化')
                    with path.open('rb') as source:
                        content = source.read(settings.max_file_size_bytes + 1)
                    file_type = validate_upload(path.name, content)
                    digest = sha256_of(content)
                    existing = db.query(Invoice).join(InvoiceFile, Invoice.file_id == InvoiceFile.id).filter(InvoiceFile.file_hash == digest).order_by(Invoice.created_at).first()
                    if existing:
                        record.update(invoice_id=existing.id, reused=True)
                    else:
                        # 有文本层的 PDF 可在 OCR/入库前排除明确不含关键词的文件。
                        if file_type == 'pdf' and data['plan']['keywords']:
                            try:
                                from io import BytesIO
                                from pypdf import PdfReader
                                reader = PdfReader(BytesIO(content))
                                text = ''.join(page.extract_text() or '' for page in reader.pages[:10])
                            except Exception:
                                text = ''
                            if len(text) > 100 and '发票' in text and any(normal(k) not in normal(text) for k in data['plan']['keywords']) and len(reader.pages) <= 10:
                                record.update(kind='excluded', reason='PDF 票面文本不含要求的关键词，未导入')
                                data['records'].append(record); data['processed'] += 1
                                save(db, task, data)
                                continue
                        stored, stored_name = save_upload(UPLOAD_DIR / 'agent' / task.id, path.name, content)
                        inv_file = InvoiceFile(id=new_id(), job_id=job.id, original_name=safe_filename(path.name), stored_name=stored_name, storage_path=str(stored), file_type=file_type, file_size=len(content), file_hash=digest, page_count=count_pages(stored, file_type), status='queued')
                        db.add(inv_file); db.flush()
                        process_file(db, inv_file)
                        inv = db.query(Invoice).filter(Invoice.file_id == inv_file.id).first()
                        if inv:
                            record.update(invoice_id=inv.id, reused=False)
                        else:
                            record['reason'] = inv_file.error_message or '识别失败'
                        db.commit()
                except Exception as exc:
                    db.rollback()
                    record['reason'] = str(exc)[:300]
                data['records'].append(record)
                data['processed'] += 1
                save(db, task, data)
            recount_job(db, job)
            job.status = 'partial' if job.failed else 'done'
            job.finished_at = datetime.now()
            task.status = 'review'
            data['log'].append('整理结束。已保存识别草稿，请过目并勾选本次需要确认的票据；不匹配和待判断票据不会自动入账。')
            save(db, task, data)
        except Exception as exc:
            db.rollback()
            task.status = 'failed'
            data['log'].append(f'任务中断，已保存的记录可以复核：{str(exc)[:300]}')
            save(db, task, data)


@router.post('/tasks/{task_id}/confirm')
def confirm(task_id: str, body: ConfirmTaskIn, db: Session = Depends(get_db)):
    task = task_or_404(db, task_id)
    if task.status not in {'review', 'confirmed'}:
        raise HTTPException(409, '请等待任务整理完成')
    allowed = {r.get('invoice_id') for r in task.payload.get('records', [])}
    selected = []
    for invoice_id in dict.fromkeys(body.invoice_ids):
        if invoice_id not in allowed:
            raise HTTPException(400, '票据不属于本任务')
        invoice = db.get(Invoice, invoice_id)
        scope = dict(task.payload['plan'])
        if invoice_id in task.payload.get('confirmed_ids', []):
            scope['exclude_confirmed'] = False
        if not invoice or matches(invoice, scope)[0] != 'matched':
            raise HTTPException(409, '存在已删除或不符合本次条件的票据，请刷新结果')
        if body.revisions.get(invoice_id) != revision(invoice):
            raise HTTPException(409, '票据在预览后发生变化，请刷新并重新过目')
        flags = validate_invoice(db, invoice, source_file=invoice.file)
        if any(f['level'] == 'error' for f in flags):
            raise HTTPException(409, f'票据 {invoice.invoice_number} 有阻断错误，请先复核修正')
        selected.append((invoice, flags))
    for invoice, flags in selected:
        invoice.risk_flags = flags
        if invoice.status != 'confirmed':
            create_ledger_entry(db, invoice, '本地 Agent 工作台人工确认')
    task.status = 'confirmed'
    data = dict(task.payload)
    data['confirmed_ids'] = list(dict.fromkeys([*data.get('confirmed_ids', []), *body.invoice_ids]))
    data['log'] = [*data['log'], f'用户已过目并确认 {len(selected)} 张票据，可导出所选已入账票据。']
    save(db, task, data)
    return output(db, task)

"""对话账本快照与导出；模型只接收统计，本地 UI 显示明细。"""
from datetime import date
from pathlib import Path
from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator

from ..config import EXPORT_DIR
from ..models import AgentArtifact, new_id
from ..schemas import ExportRequest
from ..routers import agent, exports


class LedgerQuery(BaseModel):
    model_config = ConfigDict(extra='forbid')
    status: Literal['all', 'confirmed', 'pending_review'] = 'all'
    month: str | None = Field(default=None, pattern=r'^20\d{2}-(0[1-9]|1[0-2])$')
    date_from: date | None = None
    date_to: date | None = None
    direction: Literal['input', 'output', 'unknown'] | None = None
    category: str | None = Field(default=None, max_length=100, description='仅用户明确要求按费用分类筛选时使用，精确匹配分类')
    q: str | None = Field(default=None, max_length=100, description='相关内容关键词：匹配票号、购销方、文件名、费用分类、会计科目、明细项目名称及票面备注')
    current_task_only: bool = False

    @model_validator(mode='after')
    def check_dates(self):
        if self.date_from and self.date_to and self.date_from > self.date_to:
            raise ValueError('日期起止顺序错误')
        if self.month and (self.date_from or self.date_to):
            raise ValueError('月份与日期范围不能同时指定')
        return self


class ExportQuery(BaseModel):
    model_config = ConfigDict(extra='forbid')
    query_id: str = Field(min_length=1, max_length=36)


def resolve(db, filters, task_id):
    payload = filters.model_dump(mode='json', exclude={'current_task_only'})
    if filters.current_task_only:
        if not task_id:
            raise HTTPException(422, '没有当前整理任务')
        task = agent.output(db, agent.task_or_404(db, task_id))
        if task['status'] in {'queued', 'processing'}:
            raise HTTPException(409, '任务尚未整理完成，请稍后查询或导出')
        payload['invoice_ids'] = [r['invoice']['id'] for r in task['records'] if r['kind'] == 'matched' and r.get('invoice')]
    return exports._resolve_rows(db, ExportRequest(**payload))


def query(db, conversation_id, args, task_id):
    filters = LedgerQuery.model_validate(args)
    invoices = resolve(db, filters, task_id)
    if len(invoices) > 5000:
        raise HTTPException(422, '超过单次5000张上限，请缩小日期范围')
    ids = [i.id for i in invoices]
    stats = {'count': len(ids), 'confirmed': sum(i.status == 'confirmed' for i in invoices),
             'pending': sum(i.status != 'confirmed' for i in invoices),
             'total_amount': sum(round((i.total_amount or 0) * 100) for i in invoices) / 100,
             'missing_amount': sum(i.total_amount is None for i in invoices)}
    record = AgentArtifact(id=new_id(), conversation_id=conversation_id, kind='ledger_preview', payload={
        'filters': filters.model_dump(mode='json'), 'task_id': task_id if filters.current_task_only else None,
        'ids': ids, 'revisions': {i.id: agent.revision(i) for i in invoices}, **stats})
    db.add(record); db.commit()
    card = {'id': record.id, 'kind': 'ledger_preview', **stats, 'filters': filters.model_dump(mode='json'),
            'rows': [{'id': i.id, 'number': i.invoice_number, 'seller': i.seller_name, 'date': i.invoice_date,
                      'amount': i.total_amount, 'status': i.status,
                      'errors': sum(f['level'] == 'error' for f in (i.risk_flags or []))} for i in invoices[:100]],
            'truncated': len(ids) > 100}
    # 不将客户名称、票号或明细发送给模型。
    record.payload = {**record.payload, 'card': card}
    db.commit()
    result = {'query_id': record.id, **stats, 'filters': filters.model_dump(mode='json'),
              'message': '查询已完成，页面已展示审核清单。最多预览100张，导出包含本次全部匹配记录。导出不改变入账状态。'}
    return result, card


def export(db, conversation_id, args):
    parsed = ExportQuery.model_validate(args)
    snapshot = db.get(AgentArtifact, parsed.query_id)
    if not snapshot or snapshot.kind != 'ledger_preview' or snapshot.conversation_id != conversation_id:
        raise HTTPException(404, '查询快照不存在或不属于本对话，请先查询账本')
    data = snapshot.payload
    invoices = resolve(db, LedgerQuery.model_validate(data['filters']), data.get('task_id'))
    if {i.id for i in invoices} != set(data['ids']) or any(agent.revision(i) != data['revisions'].get(i.id) for i in invoices):
        raise HTTPException(409, '账本在查询后发生变化，请重新查询后导出')
    if not invoices:
        raise HTTPException(404, '当前条件没有票据，未生成空文件')
    export_id = new_id()
    response = exports.export_excel(ExportRequest(invoice_ids=data['ids'], status='all', file_name=f'Agent台账_{export_id}'), db)
    path = Path(response.path).resolve()
    if not path.is_relative_to(EXPORT_DIR.resolve()):
        raise HTTPException(500, '导出文件路径异常')
    record = AgentArtifact(id=export_id, conversation_id=conversation_id, kind='download', payload={
        'stored_name': path.name, 'filename': response.filename, 'count': len(invoices),
        'confirmed': data['confirmed'], 'pending': data['pending'], 'query_id': snapshot.id})
    db.add(record); db.commit()
    card = {'id': export_id, 'kind': 'download', 'filename': response.filename, 'count': len(invoices),
            'pending': data['pending'], 'url': f'/api/v1/agent/ai/downloads/{export_id}'}
    return {**card, 'message': 'Excel 已实际生成，下载卡片已展示。导出未改变入账状态。'}, card

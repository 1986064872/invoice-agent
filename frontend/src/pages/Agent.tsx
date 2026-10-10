import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Bot, CheckCircle2, Upload, ArrowRight, AlertCircle } from 'lucide-react'
import { api } from '../api'
import type { Invoice } from '../types'

const presets = ['整理票据，列出异常并准备复核', '检查重复票据', '汇总票据金额']
const button = 'rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40 hover:bg-brand-700'
const secondary = 'rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm disabled:opacity-40 hover:bg-slate-50'
const samples: Invoice[] = [
  ['办公用品', 268, '办公费', ''],
  ['云服务', 1200, '研发费用', ''],
  ['设备采购', 5600, '电子设备', '疑似重复票据，请对照已有记录确认'],
  ['技术服务', 3000, '待分类', '业务用途不明确，请补充用途后选择分类'],
  ['运输服务', 350, '运输费', '票面合计与明细金额不一致，请核对原票'],
].map(([name, amount, category, issue], i) => ({
  id: `demo-${i}`, file_id: `demo-${i}`, seller_name: `示例供应商 ${i + 1}`,
  invoice_number: `DEMO000${i + 1}`, total_amount: Number(amount), expense_category: String(category),
  status: 'pending_review', items: [{ id: `item-${i}`, item_name: String(name) }], raw_url: '',
  error_count: issue ? 1 : 0, warning_count: 0,
  risk_flags: issue ? [{ code: i === 2 ? 'duplicate' : 'demo_issue', level: 'warning', message: String(issue) }] : [],
}))

export default function Agent() {
  const [prompt, setPrompt] = useState(presets[0])
  const [demo, setDemo] = useState(true)
  const [rows, setRows] = useState<Invoice[]>([])
  const [log, setLog] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [ran, setRan] = useState(false)
  const [onlyIssues, setOnlyIssues] = useState(false)
  const [deferred, setDeferred] = useState<string[]>([])
  const [jobId, setJobId] = useState<string | null>(null)
  const [files, setFiles] = useState<File[]>([])
  const [progress, setProgress] = useState(0)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const note = (s: string) => { if (alive.current) setLog(v => [...v, s]) }
  const issues = rows.filter(r => r.risk_flags.length > 0)
  const confirmed = rows.filter(r => r.status === 'confirmed')
  const visible = rows.filter(r => !onlyIssues || r.risk_flags.length > 0)

  async function readJob(id: string) {
    let job = await api.getJob(id)
    let polls = 0
    while (alive.current && ['queued', 'processing'].includes(job.status) && polls < 90) {
      setProgress(job.progress)
      await new Promise(resolve => setTimeout(resolve, 2000))
      if (!alive.current) return []
      job = await api.getJob(id)
      polls++
    }
    if (['queued', 'processing'].includes(job.status)) throw new Error('识别仍在后台进行，稍后点击“刷新本次结果”继续查看。')
    note(`批次处理结束：${job.total} 个文件，${job.failed} 个失败。`)
    job.files.filter(f => f.status === 'failed').forEach(f => note(`${f.original_name}：${f.error_message || '识别失败，请到票据中心处理'}`))
    const ids = job.files.flatMap(f => f.invoice_id ? [f.invoice_id] : [])
    return Promise.all(ids.map(id => api.getInvoice(id)))
  }

  async function run(refresh = false) {
    if (busy) return
    if (!refresh && !presets.includes(prompt.trim())) {
      setError('当前 demo 支持下方三种任务，请点击任务快捷选项。自由对话将在接入模型后提供。')
      return
    }
    setBusy(true); setError(''); setLog([]); setProgress(0)
    if (!refresh) { setRows([]); setRan(false); setDeferred([]); setJobId(null) }
    try {
      note(refresh ? '正在刷新本次票据状态。' : `任务：${prompt}`)
      let result: Invoice[]
      if (demo) {
        result = refresh ? rows : structuredClone(samples)
        note('已载入 5 张合成示例票据，不访问或修改真实账本。')
      } else if (refresh && jobId) {
        result = await readJob(jobId)
      } else if (refresh && rows.length) {
        result = await Promise.all(rows.map(r => api.getInvoice(r.id)))
      } else if (files.length && !refresh) {
        note(`上传 ${files.length} 个文件，调用现有 OCR 与规则校验。`)
        const uploaded = await api.upload(files)
        uploaded.rejected.forEach(f => note(`未接收 ${f.name}：${f.reason}`))
        if (!uploaded.job_id) throw new Error(uploaded.message)
        setJobId(uploaded.job_id)
        result = await readJob(uploaded.job_id)
      } else {
        note('读取当前全部待复核票据，保留原票面日期与字段。')
        const first = await api.listInvoices({ status: 'pending_review', page_size: 200 })
        result = [...first.items]
        for (let page = 2; page <= Math.ceil(first.total / 200); page++) {
          const next = await api.listInvoices({ status: 'pending_review', page_size: 200, page })
          result.push(...next.items)
        }
      }
      if (!alive.current) return
      setRows(result); setRan(true); setProgress(100)
      setOnlyIssues(prompt === presets[1])
      const count = result.filter(r => r.risk_flags.length > 0).length
      note(`已汇总 ${result.length} 张票据，其中 ${count} 张存在校验提示。通过校验不代表已确认入账。`)
      if (prompt === presets[1]) note('已展开异常列表，请查看重复提示；其他异常一并保留供核对。')
      if (prompt === presets[2]) note(`票面合计 ¥${result.reduce((s, r) => s + Math.round((r.total_amount || 0) * 100), 0) / 100}，含异常和待复核票据，不代表账本金额。`)
      note('请核对原票后确认；复核完成后刷新本次结果，可导出本次已入账票据。')
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '处理失败，请重试') }
    finally { if (alive.current) setBusy(false) }
  }

  async function exportResult() {
    setBusy(true); setError('')
    try {
      await api.exportExcel({ invoice_ids: confirmed.map(r => r.id), only_confirmed: true })
      note('已生成本次已入账票据的 Excel，并发起下载。')
    } catch (e) { setError(e instanceof Error ? e.message : '导出失败') }
    finally { setBusy(false) }
  }

  return <div className="space-y-6">
    <header className="flex items-center justify-between gap-4">
      <div><div className="mb-2 text-xs font-semibold tracking-widest text-brand-600">INVOICE AGENT / DEMO</div><h1 className="text-2xl font-semibold text-slate-900">交代任务，集中处理异常</h1><p className="mt-2 text-sm text-slate-500">规则驱动原型 · 已连接现有票据接口 · 尚未接入大模型</p></div>
      <Bot size={42} className="text-brand-600" />
    </header>
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_310px]">
      <div className="space-y-5">
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="mb-4 flex gap-2">{[true, false].map(value => <button key={String(value)} disabled={busy} onClick={() => { setDemo(value); setRows([]); setRan(false); setJobId(null); setLog([]); setError(''); setDeferred([]); setProgress(0) }} className={demo === value ? button : secondary}>{value ? '示例体验' : '真实票据'}</button>)}</div>
          <label htmlFor="agent-task" className="mb-2 block text-sm font-medium">这次需要完成什么？</label>
          <textarea id="agent-task" disabled={busy} value={prompt} onChange={e => setPrompt(e.target.value)} className="min-h-24 w-full rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm outline-none focus:border-brand-500" />
          <div className="mt-3 flex flex-wrap gap-2">{presets.map(p => <button key={p} disabled={busy} onClick={() => setPrompt(p)} className="rounded-full bg-brand-50 px-3 py-1.5 text-xs text-brand-700">{p}</button>)}</div>
          {!demo && <div className="mt-4 rounded-lg border border-dashed border-slate-300 p-4"><label className="flex items-center gap-2 text-sm"><Upload size={16} />上传 PDF / JPG / PNG（最多 50 个）<input aria-label="选择票据文件" className="min-w-0 flex-1 text-xs" type="file" multiple accept=".pdf,.jpg,.jpeg,.png" disabled={busy} onChange={e => setFiles(Array.from(e.target.files || []))} /></label><p className="mt-2 text-xs text-slate-500">未选文件时读取全部待复核票据；上传遵循现有 OCR 配置。刷新页面会清除本页任务状态。</p></div>}
          <div className="mt-5 flex items-center justify-between gap-3"><span className="text-xs text-slate-500">{demo ? '合成数据演示 · 不写入数据库' : `处理范围：${files.length ? `所选 ${files.length} 个文件` : '全部待复核票据'}`}</span><button disabled={busy || files.length > 50 && !demo} onClick={() => run()} className={button}>{busy ? `处理中 ${progress}%` : '开始任务 →'}</button></div>
        </section>
        {error && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>}
        {(ran || busy) && <>
          <div className="grid grid-cols-3 gap-3">{[['本次票据', rows.length], ['有校验提示', issues.length], ['已确认入账', confirmed.length]].map(([label, value]) => <div key={label} className="rounded-xl border border-slate-200 bg-white p-5"><div className="text-xs text-slate-500">{label}</div><div className="mt-2 text-3xl font-semibold">{value}</div></div>)}</div>
          <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-5"><h2 className="font-semibold">复核待办 <span className="ml-2 text-xs font-normal text-slate-400">暂缓 {deferred.length} 张</span></h2><label className="text-xs"><input type="checkbox" checked={onlyIssues} onChange={e => setOnlyIssues(e.target.checked)} /> 只看异常</label></div>
            {!visible.length && <p className="p-8 text-center text-sm text-slate-500">{busy ? '正在读取处理结果…' : '当前范围没有票据。'}</p>}
            {visible.map(row => <div key={row.id} className="border-b border-slate-100 p-5 last:border-0">
              <div className="flex justify-between gap-3"><div className="font-medium">{row.items[0]?.item_name || row.seller_name || '待补充票据'} <span className="ml-2 text-xs font-normal text-slate-400">{row.invoice_number || '号码缺失'}</span></div><div className="font-semibold">{row.total_amount == null ? '金额缺失' : `¥${row.total_amount.toFixed(2)}`}</div></div>
              <div className="mt-2 text-xs text-slate-500">{row.seller_name || '销售方待补充'} · {row.expense_category || '待分类'} · {row.status === 'confirmed' ? '已入账' : '待复核'}</div>
              {row.risk_flags.length ? row.risk_flags.map((flag, i) => <p key={i} className="mt-2 flex gap-2 text-sm text-amber-700"><AlertCircle size={16} className="mt-0.5 shrink-0" />{flag.message}</p>) : <p className="mt-2 text-sm text-emerald-700">未发现现有规则提示，请核对原票后确认。</p>}
              <div className="mt-3 flex items-center gap-4 text-xs">
                {!demo && <Link to={`/review?id=${encodeURIComponent(row.id)}`} target="_blank" rel="noreferrer" className="font-medium text-brand-600">查看原票并复核 ↗</Link>}
                {demo && row.status !== 'confirmed' && !row.risk_flags.length && <button disabled={busy} className="font-medium text-brand-600" onClick={() => { setRows(v => v.map(r => r.id === row.id ? { ...r, status: 'confirmed' } : r)); note(`模拟确认 ${row.invoice_number}，未写入真实账本。`) }}>模拟确认</button>}
                {row.status !== 'confirmed' && <button disabled={busy} className="text-slate-500" onClick={() => setDeferred(v => v.includes(row.id) ? v.filter(id => id !== row.id) : [...v, row.id])}>{deferred.includes(row.id) ? '已暂缓 · 恢复处理' : '本次暂缓'}</button>}
              </div>
            </div>)}
          </section>
        </>}
      </div>
      <aside className="space-y-5">
        <section className="rounded-2xl bg-brand-700 p-5 text-white"><h2 className="font-semibold">本次处理路径</h2><div className="mt-5 space-y-4">{['接收任务与票据', '调用识别和规则校验', '整理异常与复核待办', '人工确认后导出'].map((s, i) => <div key={s} className="flex items-center gap-3 text-sm"><span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/15 text-xs">{i + 1}</span>{s}</div>)}</div><p className="mt-5 text-xs leading-6 text-blue-200">金额计算与校验由现有程序执行。此版本不自动修改字段、不自动确认入账。</p></section>
        <section className="rounded-xl border border-slate-200 bg-white p-5"><h2 className="mb-4 font-semibold">执行记录</h2><div aria-live="polite" className="space-y-4">{log.length ? log.map((s, i) => <div key={i} className="flex gap-2 text-xs leading-5 text-slate-600"><CheckCircle2 size={14} className="mt-1 shrink-0 text-brand-500" />{s}</div>) : <p className="text-sm text-slate-400">点击开始任务，查看实际处理记录。</p>}</div></section>
        {(ran || jobId) && <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-5"><button disabled={busy} onClick={() => run(true)} className={`${secondary} w-full`}>刷新本次结果</button><button disabled={busy || demo || !confirmed.length} onClick={exportResult} className={`${button} w-full`}>导出已入账票据（{confirmed.length}）</button><p className="text-xs leading-5 text-slate-400">{demo ? '示例模式仅模拟确认；真实模式支持 Excel 导出。' : '导出只包含本次范围内已确认入账的票据。'}</p><Link to="/tickets" className="flex items-center gap-1 text-xs text-brand-600">打开票据中心 <ArrowRight size={12} /></Link></section>}
      </aside>
    </div>
  </div>
}

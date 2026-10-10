import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Bot, FolderSearch, RefreshCw, FileCheck2, ArrowRight } from 'lucide-react'
import { api } from '../api'
import { notifyDataChanged } from '../lib/refresh'
import DeepSeekPanel from '../components/DeepSeekPanel'
import { dateScopeText } from '../lib/taskScope'
import type { Invoice } from '../types'

type Plan = { prompt: string; root: string; month: string | null; months?: string[]; date_from?: string | null; date_to?: string | null; keywords: string[]; limit: number; description: string }
type Row = { path: string; kind: string; reason: string; reused?: boolean; invoice?: Invoice; revision?: string }
type Task = { id: string; status: string; plan: Plan; records: Row[]; log: string[]; processed: number; total: number; limited?: boolean }
const primary = 'rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-40'
const secondary = 'rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm hover:bg-slate-50 disabled:opacity-40'
const money = (value: number) => value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1/agent${path}`, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await response.json()
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : '请求失败，请检查任务内容或刷新重试')
  return data
}

export default function LocalAgent() {
  const [prompt, setPrompt] = useState('整理素材里的全部发票，给我过目，然后导出')
  const [root, setRoot] = useState('')
  const [sourceDir, setSourceDir] = useState('')
  const [plan, setPlan] = useState<Plan | null>(null)
  const [task, setTask] = useState<Task | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [initializing, setInitializing] = useState(true)
  const [showExcluded, setShowExcluded] = useState(false)
  const running = task?.status === 'queued' || task?.status === 'processing'
  const locked = busy || running || initializing
  const matched = task?.records.filter(r => r.kind === 'matched' && r.invoice) || []
  const selectedRows = matched.filter(r => selected.includes(r.invoice!.id))
  const eligible = matched.filter(r => !r.invoice!.risk_flags.some(f => f.level === 'error'))
  const visible = task?.records.filter(r => showExcluded || !['excluded', 'duplicate'].includes(r.kind)) || []
  const selectedTotal = selectedRows.reduce((sum, r) => sum + Math.round((r.invoice!.total_amount || 0) * 100), 0) / 100

  useEffect(() => {
    let active = true
    Promise.all([request<{root: string}>('/config'), request<Task | null>('/tasks/latest')]).then(([config, latest]) => {
      if (active) { setRoot(config.root); setTask(latest) }
    }).catch(e => { if (active) setError(e.message) }).finally(() => { if (active) setInitializing(false) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!task || !running) return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = await request<Task>(`/tasks/${task.id}`)
        if (active) {
          setTask(next); setError('')
          if (!['queued', 'processing'].includes(next.status)) notifyDataChanged()
        }
      } catch (e) { if (active) setError(e instanceof Error ? e.message : '状态读取失败，正在重试') }
      if (active) timer = setTimeout(poll, 2000)
    }
    timer = setTimeout(poll, 1000)
    return () => { active = false; clearTimeout(timer) }
  }, [task?.id, running])

  async function action(fn: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('')
    try { await fn() } catch (e) { setError(e instanceof Error ? e.message : '操作失败') }
    finally { setBusy(false) }
  }
  async function refresh() {
    if (!task) return
    const next = await request<Task>(`/tasks/${task.id}`)
    setTask(next); setSelected([])
    setNotice('已刷新票面及校验结果，请重新勾选过目的票据。')
  }
  async function confirmAndExport() {
    if (!task || !selectedRows.length) return
    const ids = selectedRows.map(r => r.invoice!.id)
    const revisions = Object.fromEntries(selectedRows.map(r => [r.invoice!.id, r.revision]))
    const updated = await request<Task>(`/tasks/${task.id}/confirm`, { invoice_ids: ids, revisions })
    setTask(updated)
    notifyDataChanged()
    setNotice(`已确认 ${ids.length} 张票据，正在导出。`)
    // 只有确认事务成功才调用导出；即使下载失败也保留已入账状态。
    await api.exportExcel({ invoice_ids: ids, only_confirmed: true })
    setNotice(`已确认 ${ids.length} 张票据并发起 Excel 下载。其余票据保留待处理状态。`)
    setSelected([])
  }

  return <div className="space-y-6">
    <header className="flex items-start justify-between gap-4"><div><div className="text-xs font-semibold tracking-widest text-brand-600">LOCAL INVOICE AGENT</div><h1 className="mt-2 text-2xl font-semibold">告诉我范围，我来找发票</h1><p className="mt-2 text-sm text-slate-500">本地查找 → 识别整理 → 待审核台账 → 你过目 → 入账并导出</p></div><Bot size={40} className="text-brand-600" /></header>
    <DeepSeekPanel taskId={task?.id} taskRunning={!!running || busy || initializing} onStarted={async () => { setTask(await request<Task | null>('/tasks/latest')); setSelected([]); setPlan(null) }} />
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="mb-3 font-semibold text-slate-600">本地规则模式（无需模型，可继续使用）</h2>
      <label className="mb-4 block text-sm"><span className="flex items-center gap-2"><FolderSearch size={18} />发票放在哪个文件夹？</span><input aria-label="发票文件夹路径" disabled={locked} value={sourceDir} onChange={e => { setSourceDir(e.target.value); setPlan(null) }} placeholder="请粘贴文件夹完整路径，例如 D:\\发票\\2025" className="mt-2 w-full rounded-lg border border-slate-200 p-3" /><button disabled={locked || !root} onClick={() => { setSourceDir(root); setPlan(null) }} className="mt-2 text-xs text-brand-600">使用项目素材目录</button></label>
      <label htmlFor="local-agent-prompt" className="mb-2 block text-sm font-medium">需要整理哪些发票？</label>
      <textarea id="local-agent-prompt" disabled={locked} value={prompt} onChange={e => { setPrompt(e.target.value); setPlan(null) }} className="min-h-24 w-full rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm focus:outline-brand-500" />
      <div className="mt-3 flex flex-wrap gap-2">{['整理素材里的全部发票', '整理2026年9月的发票', '整理包含“公司名”的发票'].map(text => <button key={text} disabled={locked} onClick={() => { setPrompt(text); setPlan(null) }} className="rounded-full bg-brand-50 px-3 py-1.5 text-xs text-brand-700">{text}</button>)}</div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3"><p className="max-w-2xl text-xs leading-5 text-slate-500">支持全年、多个月份、日期区间及引号内的公司／项目关键词，多个关键词同时匹配。采用本地指令解析，未接大模型；无法理解的条件会提示补充。搜索包含子文件夹，原文件保持不变。</p><button disabled={locked || !prompt.trim() || !sourceDir.trim()} className={primary} onClick={() => action(async () => setPlan(await request<Plan>('/plan', { prompt, source_dir: sourceDir })))}>理解任务 <ArrowRight className="ml-1 inline" size={14} /></button></div>
      {plan && <div className="mt-5 rounded-xl border border-brand-200 bg-brand-50 p-4"><h2 className="font-semibold text-brand-700">我理解的任务范围</h2><p className="mt-2 text-sm">开票月份：{dateScopeText(plan)}　关键词：{plan.keywords.join(' + ') || '不限'}</p><p className="mt-2 text-xs leading-5 text-slate-600">来源：{plan.root}。{plan.description} 单次最多处理 {plan.limit} 个 PDF／图片候选，超出会明确提示。识别沿用系统 OCR 设置。</p><button disabled={locked} className={`${primary} mt-4`} onClick={() => action(async () => { const next = await request<Task>('/tasks', { prompt: plan.prompt, source_dir: plan.root }); setTask(next); setSelected([]); setPlan(null) })}>开始查找并整理</button></div>}
    </section>
    {error && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>}
    {notice && <div role="status" className="rounded-xl bg-emerald-50 p-4 text-sm text-emerald-800">{notice}</div>}
    {task && <>
      <section className="rounded-xl border border-slate-200 bg-white p-5"><div className="flex flex-wrap justify-between gap-3"><div><h2 className="font-semibold">{running ? '正在本地整理' : task.status === 'failed' ? '任务中断' : '整理结果，等你过目'}</h2><p className="mt-1 text-sm text-slate-500">{task.plan.prompt} · 来源：{task.plan.root} · 日期：{dateScopeText(task.plan)}</p></div><button disabled={locked} className={secondary} onClick={() => action(refresh)}><RefreshCw size={14} className="mr-1 inline" />刷新复核结果</button></div><div className="mt-4 h-2 rounded-full bg-slate-100"><div className="h-2 rounded-full bg-brand-500 transition-all" style={{ width: `${task.total ? task.processed / task.total * 100 : 0}%` }} /></div><p className="mt-2 text-xs text-slate-500">处理 {task.processed} / {task.total} 个候选 · 符合条件 {matched.length} 张 · 已选 {selectedRows.length} 张</p>{task.limited && <p className="mt-3 text-sm text-amber-700">达到扫描上限，本次结果不完整。请缩小素材目录范围后再整理。</p>}<div className="mt-4 space-y-1 border-t border-slate-100 pt-3">{task.log.map((entry, i) => <p key={i} className="text-xs leading-6 text-slate-500">{entry}</p>)}</div></section>
      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-5"><h2 className="flex items-center gap-2 font-semibold"><FileCheck2 size={18} />待审核台账</h2><label className="text-xs text-slate-500"><input type="checkbox" checked={showExcluded} onChange={e => setShowExcluded(e.target.checked)} /> 显示不匹配和重复来源</label></header>
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="p-4"><input aria-label="勾选全部可确认票据" type="checkbox" disabled={locked || !eligible.length} checked={eligible.length > 0 && eligible.every(r => selected.includes(r.invoice!.id))} onChange={e => setSelected(e.target.checked ? eligible.map(r => r.invoice!.id) : [])} /></th><th className="p-4">票据与本地来源</th><th className="p-4">开票日期 / 分类</th><th className="p-4">价税合计</th><th className="p-4">核对结果</th><th className="p-4">操作</th></tr></thead><tbody>
          {visible.map((row, index) => { const inv = row.invoice; const selectable = row.kind === 'matched' && inv && !inv.risk_flags.some(f => f.level === 'error'); return <tr key={`${row.path}-${index}`} className="border-t border-slate-100 align-top"><td className="p-4"><input aria-label={`选择 ${row.path}`} type="checkbox" checked={!!inv && row.kind !== 'duplicate' && selected.includes(inv.id)} disabled={locked || !selectable} onChange={e => inv && setSelected(v => e.target.checked ? [...v, inv.id] : v.filter(id => id !== inv.id))} /></td><td className="max-w-72 p-4"><div className="font-medium">{inv?.seller_name || '待识别票据'}</div><div className="mt-1 text-xs text-slate-500">{inv?.invoice_number || '号码待补充'}</div><div className="mt-2 break-all text-xs text-slate-400">{row.path}</div>{row.reused && <span className="text-xs text-brand-600">复用已有记录</span>}</td><td className="p-4"><div>{inv?.invoice_date || '待补充'}</div><div className="mt-1 text-xs text-slate-500">{inv?.expense_category || '待分类'}</div></td><td className="whitespace-nowrap p-4">{inv?.total_amount == null ? '待核对' : `¥${money(inv.total_amount)}`}</td><td className="max-w-80 p-4"><div className={row.kind === 'matched' ? 'text-emerald-700' : 'text-amber-700'}>{row.reason}</div>{inv?.risk_flags.map((flag, i) => <p key={i} className={`mt-2 text-xs ${flag.level === 'error' ? 'text-red-600' : 'text-amber-700'}`}>{flag.message}</p>)}{inv?.status === 'confirmed' && <div className="mt-2 text-xs text-brand-600">已入账</div>}</td><td className="whitespace-nowrap p-4">{inv && <Link className="text-brand-600" to={`/review?id=${encodeURIComponent(inv.id)}`} target="_blank" rel="noreferrer">查看原票 ↗</Link>}</td></tr> })}
        </tbody></table></div>
        {!visible.length && <p className="p-8 text-center text-sm text-slate-500">{running ? '正在扫描或识别，请稍候…' : '当前没有待审核票据，可展开不匹配记录查看原因。'}</p>}
        <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-slate-200 bg-slate-50 p-5"><div><p className="text-sm font-medium">已选 {selectedRows.length} 张 · 票面合计 ¥{money(selectedTotal)}</p><p className="mt-1 text-xs text-slate-500">勾选表示你已过目。红色错误和条件不符的票据须先复核；未勾选的本次不入账、不导出。</p></div><button disabled={locked || !selectedRows.length || !['review', 'confirmed'].includes(task.status)} className={primary} onClick={() => action(confirmAndExport)}>确认所选并导出 Excel</button></footer>
      </section>
    </>}
    <p className="text-xs text-slate-400">任务保存在本机，刷新可恢复最近一次任务。图片需识别后才能判断范围；不匹配的识别草稿保留在票据中心。<Link className="ml-2 text-brand-600" to="/agent-demo">查看示例演示</Link></p>
  </div>
}

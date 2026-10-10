import { useEffect, useState } from 'react'
import { dateScopeText } from '../lib/taskScope'
import { Link } from 'react-router-dom'

type Config = { configured: boolean; model: string; enabled: boolean; base_url: string }
type Draft = { summary: string; month: string | null; months: string[]; date_from: string | null; date_to: string | null; source_dir: string | null; keywords: string[]; buyer: string | null; seller: string | null; exclude_confirmed: boolean; min_amount: number | null; max_amount: number | null }
type Artifact = { id: string; kind: 'ledger_preview' | 'download'; count: number; pending: number; confirmed?: number; total_amount?: number; missing_amount?: number; filename?: string; url?: string; truncated?: boolean; rows?: { id: string; number: string | null; seller: string | null; date: string | null; amount: number | null; status: string; errors: number }[] }
type ChatResult = { conversation_id: string; reply: string; draft: Draft | null; trace: string[]; artifacts?: Artifact[]; started_task_id?: string | null }
type RestoredChat = { conversation_id: string; messages: { role: string; text: string }[]; draft: Draft | null; artifacts: Artifact[] }
const ACTIVE_CHAT = 'invoice-agent-active-chat-v1'
let pendingChat: Promise<ChatResult> | null = null
function savedChat() { try { return localStorage.getItem(ACTIVE_CHAT) } catch { return null } }
function saveChat(id: string) { try { localStorage.setItem(ACTIVE_CHAT, id) } catch { /* Storage may be disabled. */ } }
function inputKey(id: string | null) { return 'invoice-agent-input-v1:' + (id || 'new') }
function saveInput(id: string | null, text: string) { try { sessionStorage.setItem(inputKey(id), text) } catch { /* Keep the in-memory input. */ } }
function readInput(id: string | null) { try { return sessionStorage.getItem(inputKey(id)) || '' } catch { return '' } }
const button = 'rounded-lg bg-brand-600 px-4 py-2 text-sm text-white disabled:opacity-40'
async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1/agent/ai${path}`, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await response.json()
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : '请求失败，请检查配置或输入')
  return data
}

export default function DeepSeekPanel({ taskId, taskRunning, onStarted }: { taskId?: string; taskRunning: boolean; onStarted: () => Promise<void> }) {
  const [config, setConfig] = useState<Config | null>(null)
  const [key, setKey] = useState('')
  const [model, setModel] = useState('deepseek-flash')
  const [enabled, setEnabled] = useState(false)
  const [conversation, setConversation] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [messages, setMessages] = useState<{ role: string; text: string }[]>([])
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [restoring, setRestoring] = useState(true)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    call<Config>('/config').then(c => { if (active) { setConfig(c); setModel(c.model); setEnabled(c.enabled) } }).catch(e => { if (active) setError(e.message) })
    async function restore() {
      try {
        // A request continues when this route unmounts. Restore after it settles.
        if (pendingChat) { try { await pendingChat } catch { /* Restore the last saved turn. */ } }
        const id = savedChat()
        if (id === 'new') { if (active) setInput(readInput(null)); return }
        const chat = await call<RestoredChat | null>(id ? `/conversations/${encodeURIComponent(id)}` : '/conversations/latest')
        if (active && chat) {
          saveChat(chat.conversation_id)
          setConversation(chat.conversation_id); setMessages(chat.messages); setDraft(chat.draft); setArtifacts(chat.artifacts)
          setInput(readInput(chat.conversation_id))
        } else if (active) setInput(readInput(null))
      } catch (e) { if (active) setError(e instanceof Error ? e.message : '聊天记录恢复失败，请刷新重试') }
      finally { if (active) setRestoring(false) }
    }
    void restore()
    return () => { active = false }
  }, [])
  async function run(fn: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('')
    try { await fn() } catch (e) { setError(e instanceof Error ? e.message : '请求失败') }
    finally { setBusy(false) }
  }
  async function send() {
    const text = input.trim()
    if (!text) return
    pendingChat = call<ChatResult>('/chat', { message: text, conversation_id: conversation, task_id: taskId }).then(result => {
      saveChat(result.conversation_id); saveInput(conversation, ''); saveInput(result.conversation_id, '')
      return result
    })
    let result: ChatResult
    try { result = await pendingChat } finally { pendingChat = null }
    setConversation(result.conversation_id); setDraft(result.draft)
    setMessages(v => [...v, { role: '你', text }, { role: 'DeepSeek', text: result.reply }, ...result.trace.map(text => ({ role: '工具执行', text }))])
    setArtifacts(v => [...v, ...(result.artifacts || [])])
    setInput('')
    if (result.started_task_id) await onStarted()
  }
  return <section className="rounded-2xl border border-brand-200 bg-white p-6 shadow-sm">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold text-brand-700">DeepSeek 对话助手</h2><p className="mt-1 text-xs text-slate-500">{config?.configured && config.enabled ? `已配置 ${config.model} · 连接状态请使用测试按钮验证` : '尚未启用大模型，请先配置 API Key'}</p></div><button disabled={busy || restoring} className="text-sm text-brand-600" onClick={() => { saveChat('new'); saveInput(null, ''); setConversation(null); setMessages([]); setArtifacts([]); setDraft(null); setInput(''); setError(''); setNotice('已开始新对话') }}>新对话</button></div>
    <details className="mt-4 rounded-lg bg-slate-50 p-4" open={!config?.configured}><summary className="cursor-pointer text-sm font-medium">DeepSeek API 配置</summary>
      <p className="mt-3 text-xs leading-6 text-slate-500">接口固定为 api.deepseek.com。密钥仅保存在本机 data 目录，不写入前端存储、不回显；本机配置文件为明文，请勿分享。留空保留已有密钥。</p>
      <div className="mt-3 grid gap-3 md:grid-cols-2"><label className="text-xs">API Key<input type="password" autoComplete="off" disabled={busy || restoring} value={key} onChange={e => setKey(e.target.value)} placeholder={config?.configured ? '已保存，留空不修改' : '在这里填写 DeepSeek API Key'} className="mt-1 w-full rounded-lg border border-slate-200 bg-white p-3 text-sm" /></label><label className="text-xs">模型名称<input disabled={busy || restoring} value={model} onChange={e => setModel(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 bg-white p-3 text-sm" /></label></div>
      <label className="mt-4 flex items-start gap-2 text-xs leading-6"><input type="checkbox" disabled={busy || restoring} checked={enabled} onChange={e => setEnabled(e.target.checked)} className="mt-1.5" />启用 DeepSeek：将我的对话、整理条件及必要的任务汇总发送给 DeepSeek 官方 API。此对话功能不上传原始发票图片或 PDF；调用按服务商规则计费。</label>
      <div className="mt-3 flex flex-wrap gap-3"><button disabled={busy || restoring} className={button} onClick={() => run(async () => { const saved = await call<Config>('/config', { api_key: key || null, model, enabled }); setConfig(saved); setKey(''); setNotice('已保存本机配置，尚未测试连接') })}>保存配置</button><button disabled={busy || restoring || !config?.configured || !config.enabled} className={button} onClick={() => run(async () => { const result = await call<{ message: string }>('/test', {}); setNotice(result.message) })}>测试连接（少量调用）</button><a className="self-center text-xs text-brand-600" href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer">获取 API Key ↗</a></div>
    </details>
    {!!messages.length && <div className="mt-4 max-h-96 space-y-3 overflow-auto rounded-lg border border-slate-100 p-4" aria-live="polite">{messages.map((message, i) => <div key={i} className={message.role === '你' ? 'rounded-lg bg-brand-50 p-3' : 'p-2'}><div className="text-xs font-medium text-brand-600">{message.role}</div><p className="mt-1 whitespace-pre-wrap text-sm leading-6">{message.text}</p></div>)}</div>}
    {artifacts.map(artifact => <section key={artifact.id} className="mt-4 rounded-xl border border-brand-200 bg-brand-50 p-4">
      {artifact.kind === 'download' ? <><h3 className="font-semibold">Excel 已生成 · {artifact.count} 张票据</h3><p className="mt-1 text-xs text-slate-600">含待复核 {artifact.pending} 张。导出没有改变入账状态。</p><a className="mt-3 inline-block rounded-lg bg-brand-600 px-4 py-2 text-sm text-white" href={artifact.url} download>下载 Excel</a></> : <>
        <h3 className="font-semibold">账本查询 / 审核清单 · {artifact.count} 张</h3><p className="mt-2 text-sm">已入账 {artifact.confirmed} 张 · 待复核 {artifact.pending} 张 · 票面金额合计 ¥{artifact.total_amount?.toFixed(2)}</p>
        {!!artifact.missing_amount && <p className="mt-1 text-xs text-amber-700">{artifact.missing_amount} 张金额缺失，未计入金额合计。</p>}
        <div className="mt-3 max-h-72 overflow-auto"><table className="w-full text-left text-xs"><thead><tr><th className="p-2">销售方 / 票号</th><th className="p-2">日期</th><th className="p-2">金额</th><th className="p-2">状态 / 复核</th><th className="p-2">操作</th></tr></thead><tbody>{artifact.rows?.map(row => <tr key={row.id} className="border-t border-brand-100"><td className="p-2">{row.seller || '待补充'}<div className="text-slate-500">{row.number || '号码缺失'}</div></td><td className="p-2">{row.date || '待补充'}</td><td className="p-2">{row.amount == null ? '待补充' : row.amount.toFixed(2)}</td><td className="p-2"><a href={`/review?id=${encodeURIComponent(row.id)}`} target="_blank" rel="noreferrer" className="text-brand-700 underline">{row.status === 'confirmed' ? '已入账' : '待复核'}{row.errors ? ` · ${row.errors} 项错误` : ''} ↗</a></td><td className="p-2"><Link to={`/ledger?focus=${encodeURIComponent(row.id)}`} className="inline-flex rounded-md border border-brand-200 bg-white px-3 py-1.5 font-medium text-brand-700 hover:bg-brand-100">详情</Link></td></tr>)}</tbody></table></div>
        <p className="mt-2 text-xs text-slate-500">{artifact.truncated ? '清单仅展示前100张；导出包含全部匹配票据。' : '清单是查询时的快照。'} 可继续说“把这些导出”；入账请查看原票后确认。</p>
      </>}
    </section>)}
    <label htmlFor="deepseek-message" className="mt-4 block text-sm font-medium">可以直接说“导出当前账本”“查询9月已入账的发票”或“开始整理素材里的发票”</label>
    <textarea id="deepseek-message" disabled={busy || restoring || !config?.enabled} value={input} onChange={e => { setInput(e.target.value); saveInput(conversation, e.target.value) }} placeholder="例如：整理上个月开给示例公司的发票，已经入账的不用重复整理。" className="mt-2 min-h-24 w-full rounded-xl border border-slate-200 p-3 text-sm disabled:bg-slate-50" />
    <div className="mt-3 flex justify-end"><button disabled={busy || restoring || !config?.configured || !config.enabled || !input.trim()} className={button} onClick={() => run(send)}>{restoring ? '恢复聊天中…' : busy ? '处理中…' : '发送给 DeepSeek'}</button></div>
    {draft && <div className="mt-4 rounded-xl bg-brand-50 p-4"><h3 className="font-semibold">模型准备的整理计划</h3><p className="mt-2 text-sm">{draft.summary}</p><div className="mt-2 space-y-1 text-xs leading-6"><p>开票月份：{dateScopeText(draft)} · 关键词：{draft.keywords.join(' + ') || '不限'}</p><p>购买方包含：{draft.buyer || '不限'} · 销售方包含：{draft.seller || '不限'}</p><p>价税合计：{draft.min_amount ?? '不限'} 至 {draft.max_amount ?? '不限'} 元（包含边界） · 排除已入账：{draft.exclude_confirmed ? '是' : '否'}</p><p>搜索目录：{draft.source_dir || '请先在对话中提供发票位置'}</p></div><button disabled={busy || restoring || taskRunning || !conversation || !draft.source_dir} className={`${button} mt-3`} onClick={() => run(async () => { await call(`/conversations/${conversation}/start`, {}); await onStarted(); setNotice('本地整理已启动，请查看下方任务进度与待审核台账') })}>按此计划开始本地整理</button></div>}
    {error && <p role="alert" className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}{notice && <p role="status" className="mt-3 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-700">{notice}</p>}
  </section>
}

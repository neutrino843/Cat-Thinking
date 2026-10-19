import { useEffect, useRef, useState } from 'react'
import { HttpProviderSettingsClient, providerSettingsErrorText } from '../analysis/providerSettingsClient'
import { getProviderPreset, type PersonalProviderStatus } from '@cat-thinking/analysis-contracts'

const decoder = { parse(value: unknown) {
  const result = value as { answer: string; model: string; local: boolean }
  if (typeof result?.answer !== 'string' || !result.answer.trim() || result.answer.length > 16000 || typeof result.model !== 'string' || typeof result.local !== 'boolean') throw new Error()
  return result
} }
export default function LocalIsisChat() {
  const [question, setQuestion] = useState('')
  const [context, setContext] = useState('')
  const [answer, setAnswer] = useState('')
  const [model, setModel] = useState('')
  const [answerLocal, setAnswerLocal] = useState(true)
  const [status, setStatus] = useState<PersonalProviderStatus>()
  const [connectionError, setConnectionError] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const controller = useRef<AbortController>()
  useEffect(() => {
    let connection: AbortController | undefined
    const refresh = () => {
      connection?.abort(); controller.current?.abort()
      connection = new AbortController()
      const signal = connection.signal
      setStatus(undefined); setConnectionError('')
      void new HttpProviderSettingsClient().status(signal).then((value) => { if (!signal.aborted) setStatus(value) })
        .catch((failure) => { if (!signal.aborted) setConnectionError(providerSettingsErrorText(failure)) })
    }
    refresh(); window.addEventListener('cat-thinking:ai-settings-changed', refresh)
    return () => { connection?.abort(); controller.current?.abort(); window.removeEventListener('cat-thinking:ai-settings-changed', refresh) }
  }, [])
  const local = status?.networkMode === 'local-loopback'
  const ready = status?.enabled && status.protocol === 'chat-completions'
  const service = getProviderPreset(status?.providerId ?? '')?.label ?? '已配置的 AI 服务'
  const host = status?.baseUrl ? new URL(status.baseUrl).host : ''
  const send = async () => {
    if (busy || !question.trim() || !ready || !status) return
    controller.current = new AbortController(); setBusy(true); setError('')
    try {
      const result = await new HttpProviderSettingsClient(undefined, 125000).localOperation('/chat', 'POST', decoder, controller.current.signal, { question, context, expectedRevision: status.revision })
      if (result.local !== local) throw new Error('provider_location_changed')
      setAnswer(result.answer); setModel(result.model); setAnswerLocal(result.local)
    } catch (failure) {
      setError(controller.current.signal.aborted ? '已停止等待，问题和资料仍保留。' : `${providerSettingsErrorText(failure)} 请在 AI 设置中核对当前连接。不会自动切换其他服务。`)
    } finally { setBusy(false) }
  }
  return <div className="isis-local-chat">
    <p>只发送下方填写的资料和问题，每次独立作答。</p>
    {status ? <p role="status">{ready ? local ? `本机模型 · ${status.modelId}，内容仅发往当前电脑。` : `${service} · ${status.modelId} · ${host}。点击发送会将下方内容发往该互联网服务，并使用你的账号额度。` : '请先在「更多 → AI 设置」保存并启用聊天接口连接。'}</p> : <p role={connectionError ? 'alert' : 'status'}>{connectionError || '正在读取当前模型连接…'}</p>}
    <label>参考原文（可选）<textarea aria-label="伊希斯参考原文" maxLength={12000} rows={3} value={context} onChange={(event) => setContext(event.target.value)} placeholder="粘贴当前需要讲解的资料，最多 12000 字符"/></label>
    <form onSubmit={(event) => { event.preventDefault(); void send() }}><label>想问伊希斯什么<textarea aria-label={local ? '本机伊希斯问题' : '伊希斯问题'} maxLength={2000} rows={2} value={question} onChange={(event) => setQuestion(event.target.value)}/></label>
      <button className="tbtn primary" disabled={busy || !question.trim() || !ready}>{local ? '发送给本机模型' : '发送给当前模型'}</button>{busy && <button className="tbtn" type="button" onClick={() => controller.current?.abort()}>停止等待</button>}</form>
    {busy && <p role="status">伊希斯正在思考…</p>}
    {error && <p role="alert">{error}</p>}
    {answer && <section aria-label={answerLocal ? '伊希斯本机回答' : '伊希斯模型回答'} aria-live="polite"><small>{answerLocal ? '本机模型' : '互联网模型'} · {model} · 请核对原文</small><p className="isis-local-answer">{answer}</p></section>}
  </div>
}

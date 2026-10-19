import { useEffect, useRef, useState } from 'react'
import { HttpProviderSettingsClient, providerSettingsErrorText } from '../analysis/providerSettingsClient'
import ModelStoragePicker from './ModelStoragePicker'

interface State { running: boolean; models: string[]; download: { state: string; model?: string; completed: number; total: number }; message?: string }
const decoder = { parse(value: unknown): State {
  const state = value as State
  if (!state || typeof state.running !== 'boolean' || !Array.isArray(state.models) || !state.download || typeof state.download.state !== 'string') throw new Error()
  return state
} }
export default function LocalModelSetup({ onChoose }: { onChoose: (model: string) => void }) {
  const [state, setState] = useState<State>()
  const [model, setModel] = useState('qwen3:4b')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const lifetime = useRef(new AbortController())
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller
    const read = async () => { try { const result = await new HttpProviderSettingsClient().localOperation('/local-models', 'GET', decoder, controller.signal); if (!controller.signal.aborted) setState(result) } catch { /* Explicit actions show connection failures. */ } }
    void read(); const timer = setInterval(() => { void read() }, 3000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [])
  const action = async (name: 'start' | 'stop' | 'pull' | 'cancel') => {
    setBusy(true); setError('')
    try { setState(await new HttpProviderSettingsClient(undefined, 30000).localOperation(`/local-models/${name}`, 'POST', decoder, lifetime.current.signal, name === 'pull' ? { model } : {})) }
    catch (failure) { if (!lifetime.current.signal.aborted) setError(providerSettingsErrorText(failure)) }
    finally { setBusy(false) }
  }
  return <section className="local-model-setup" aria-label="离线模型管理">
    <h3>准备离线 AI</h3><p>完整版安装包携带本机模型引擎，在这里启动、下载和选择模型。首次下载需要联网和数 GB 磁盘空间；已下载模型可断网使用。源码运行且缺少引擎时，可先<a href="https://ollama.com/download" target="_blank" rel="noreferrer">安装 Ollama</a>。</p>
    <p role="status">{state?.running ? `引擎已启动 · ${state.models.length} 个已下载模型` : state?.message ?? '正在检查本机引擎…'}</p>
    <ModelStoragePicker running={state?.running ?? false}/>
    <button type="button" className="tbtn" disabled={busy || state?.running} onClick={() => { void action('start') }}>启动本机引擎</button>
    {state?.running && <button type="button" className="tbtn" disabled={busy} onClick={() => { void action('stop') }}>停止本软件启动的引擎</button>}
    <label>下载模型<select aria-label="下载模型" value={model} onChange={(event) => setModel(event.target.value)}><option value="qwen3:4b">Qwen3 4B · 较小模型</option><option value="qwen3:8b">Qwen3 8B · 更高资源需求</option></select></label>
    <button type="button" className="tbtn" disabled={busy || !state?.running || state?.download.state === 'downloading'} onClick={() => { void action('pull') }}>下载所选模型</button>
    {state?.download.state === 'downloading' && <div role="status"><p>正在下载 {state.download.model}；进度表示当前模型文件。</p><progress aria-label="模型文件下载进度" max={state.download.total || 1} value={state.download.completed}/><button type="button" className="tbtn" disabled={busy} onClick={() => { void action('cancel') }}>停止下载</button></div>}
    {state?.download.state === 'failed' && <p role="alert">下载未完成或已停止。请检查网络、磁盘空间和引擎状态后重试；引擎会复用已有下载。</p>}
    {state?.models.filter((id) => !/cloud/iu.test(id)).map((id) => <button type="button" className="tbtn" key={id} onClick={() => onChoose(id)}>使用 {id}</button>)}
    <p>选择后请点击下方「保存并连接」。整篇分析、出题沿用 AI 分析入口；小模型效果和速度取决于电脑配置，生成结果需核对原文。</p>
    {error && <p role="alert">{error}</p>}
  </section>
}

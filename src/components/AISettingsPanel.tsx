import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import {
  PROVIDER_CATALOG,
  getProviderPreset,
  inferProviderProtocolFromUrl,
  personalProviderModelsInputSchema,
  type PersonalProviderModelsInput,
  type PersonalProviderModel,
  type PersonalProviderStatus,
  type ProviderNetworkMode,
  type ProviderProtocol,
  type ProviderStructuredOutput,
} from '@cat-thinking/analysis-contracts'
import { canReuseSavedProviderKey, HttpProviderSettingsClient, isTextModelSuggestion, providerSettingsErrorText } from '../analysis/providerSettingsClient'

interface ConnectionForm {
  providerId: string
  baseUrl: string
  modelId: string
  protocol: ProviderProtocol
  structuredOutput: ProviderStructuredOutput
  networkMode: ProviderNetworkMode
}

const initialPreset = getProviderPreset('openai') ?? PROVIDER_CATALOG[0]
const initialForm: ConnectionForm = {
  providerId: initialPreset.id, baseUrl: initialPreset.baseUrl,
  modelId: initialPreset.models[0]?.id ?? '', protocol: initialPreset.protocol,
  structuredOutput: initialPreset.structuredOutput, networkMode: initialPreset.networkMode,
}

const statusLabel = (status?: PersonalProviderStatus): string => {
  if (!status) return '正在读取连接'
  if (!status.available) return '由管理员管理连接'
  if (status.enabled && status.acceptsRuns) return '已连接，可以开始分析'
  if (status.checkState === 'failed') return '连接未成功'
  if (status.configured) return '已保存，分析已暂停'
  return '还未连接 AI'
}

const statusMessage = (status: PersonalProviderStatus): string => {
  if (!status.available) return '当前应用使用统一管理的 AI 连接。你可以继续查看已有分析结果。'
  if (status.enabled && status.acceptsRuns) return '连接已启用。回到文档，导入原文后即可开始分析。'
  if (status.messageKey === 'analysis.personal.credentials_rejected') return '服务商没有接受这个 API 密钥，请确认密钥有效且属于当前服务地址。'
  if (status.checkState === 'failed') return '连接检查未通过，请确认 API 密钥、服务地址和模型是否可用，再重新连接。'
  if (status.messageKey === 'analysis.personal.models_not_supported') return '这个服务未提供模型列表。可以手动填写模型后连接，首次分析会验证模型是否可用。'
  if (status.configured) return '你的连接配置已保存在本地服务中。再次连接后即可创建新的分析任务。'
  return '选择你使用的 AI 服务，填入 API 密钥和模型即可。'
}

/** Secrets live only in this mounted input and the transient request body. */
export default function AISettingsPanel({ onClose, onConnected }: { onClose: () => void; onConnected: () => void }) {
  const [client] = useState(() => new HttpProviderSettingsClient())
  const [status, setStatus] = useState<PersonalProviderStatus>()
  const [form, setForm] = useState<ConnectionForm>(initialForm)
  const [apiKey, setApiKey] = useState('')
  const [models, setModels] = useState<PersonalProviderModel[]>([])
  const [modelSource, setModelSource] = useState<'provider' | 'catalog'>('catalog')
  const [busy, setBusy] = useState('正在读取连接…')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirmForget, setConfirmForget] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const providerSelect = useRef<HTMLSelectElement>(null)
  const operation = useRef<AbortController>()
  const alive = useRef(false)
  const previousFocus = useRef<HTMLElement | null>(null)
  const initialFocusDone = useRef(false)

  const adopt = (next: PersonalProviderStatus, hydrate = false) => {
    setStatus(next)
    if (hydrate && next.configured) {
      setForm({
        providerId: next.providerId ?? initialForm.providerId,
        baseUrl: next.baseUrl ?? initialForm.baseUrl,
        modelId: next.modelId ?? initialForm.modelId,
        protocol: next.protocol ?? initialForm.protocol,
        structuredOutput: next.structuredOutput ?? initialForm.structuredOutput,
        networkMode: next.networkMode ?? initialForm.networkMode,
      })
    }
  }

  useEffect(() => {
    alive.current = true
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const element = dialog.current
    element?.showModal()
    providerSelect.current?.focus()
    const controller = new AbortController()
    operation.current = controller
    void client.status(controller.signal).then((next) => {
      if (alive.current && !controller.signal.aborted) adopt(next, true)
    }).catch((reason) => {
      if (alive.current && !controller.signal.aborted) setError(providerSettingsErrorText(reason))
    }).finally(() => {
      if (operation.current === controller) operation.current = undefined
      if (alive.current && !controller.signal.aborted) setBusy('')
    })
    return () => {
      alive.current = false
      operation.current?.abort()
      element?.close()
      if (previousFocus.current?.isConnected) previousFocus.current.focus()
    }
  }, [client])

  useEffect(() => {
    if (!busy && status?.available && !initialFocusDone.current) {
      initialFocusDone.current = true
      providerSelect.current?.focus()
    }
  }, [busy, status?.available])

  const run = async (label: string, task: (signal: AbortSignal) => Promise<void>) => {
    if (operation.current) return
    const controller = new AbortController()
    operation.current = controller
    setBusy(label); setError(''); setNotice(''); setConfirmForget(false)
    try { await task(controller.signal) } catch (reason) {
      if (alive.current && !controller.signal.aborted) setError(providerSettingsErrorText(reason))
    } finally {
      if (operation.current === controller) operation.current = undefined
      if (alive.current && !controller.signal.aborted) setBusy('')
    }
  }

  const readStatus = () => void run('正在重新连接本地服务…', async (signal) => {
    const next = await client.status(signal)
    if (alive.current && !signal.aborted) { adopt(next, true); setApiKey('') }
  })

  const selectProvider = (id: string) => {
    const preset = getProviderPreset(id)
    if (!preset) return
    setForm({ providerId: id, baseUrl: preset.baseUrl, modelId: preset.models[0]?.id ?? '',
      protocol: preset.protocol, structuredOutput: preset.structuredOutput, networkMode: preset.networkMode })
    setApiKey(''); setModels([]); setModelSource('catalog'); setNotice(''); setError('')
  }

  const changeBaseUrl = (value: string) => {
    let networkMode = form.networkMode
    try {
      const hostname = new URL(value).hostname.toLowerCase()
      networkMode = ['localhost', '127.0.0.1', '[::1]'].includes(hostname) ? 'local-loopback' : 'public'
    } catch { /* Keep the current mode while an address is being typed. */ }
    setForm({ ...form, baseUrl: value, protocol: inferProviderProtocolFromUrl(value) ?? form.protocol, networkMode })
    setModels([]); setModelSource('catalog')
  }

  const preview = (requireModel = true): PersonalProviderModelsInput | undefined => {
    const input = { version: 1 as const, ...form, modelId: form.modelId.trim() || undefined, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }
    const parsed = personalProviderModelsInputSchema.safeParse(input)
    if (!parsed.success || requireModel && !input.modelId) {
      setError(requireModel ? '请填写有效的服务地址和模型名称。模型名称应与服务商显示的名称一致，不含空格。' : '请填写有效的服务地址后读取模型。')
      return
    }
    const preset = getProviderPreset(form.providerId)
    const canReuseKey = canReuseSavedProviderKey(status, form)
    if (preset?.requiresApiKey !== false && !input.apiKey && !canReuseKey) {
      setError('请填入这个 AI 服务的 API 密钥。')
      return
    }
    return parsed.data
  }

  const save = (connect: boolean) => {
    const input = preview()
    if (!input || !status?.available || operation.current) return
    setApiKey('')
    void run(connect ? '正在保存并连接 AI…' : '正在保存连接…', async (signal) => {
      let next = await client.save({ ...input, modelId: form.modelId.trim(), expectedRevision: status.revision }, signal)
      if (!alive.current || signal.aborted) return
      adopt(next, true)
      if (connect) {
        next = await client.check({ version: 1, expectedRevision: next.revision }, signal)
        if (!alive.current || signal.aborted) return
        adopt(next)
        if (next.checkState !== 'ready') {
          if (next.messageKey === 'analysis.personal.models_not_supported') setNotice('这个服务未提供模型列表。请确认模型名称后，选择「使用手填模型连接」。首次分析会使用你的服务商额度。')
          else setError(statusMessage(next))
          return
        }
        next = await client.enable({ version: 1, expectedRevision: next.revision }, signal)
        if (!alive.current || signal.aborted) return
        adopt(next)
        if (next.enabled && next.acceptsRuns) {
          setNotice('AI 已连接。你可以回到文档开始分析。')
          onConnected()
        } else setNotice('连接已保存，暂时无法开始新分析。可以稍后重新连接。')
      } else setNotice('连接已保存，分析保持暂停。')
    })
  }

  const refreshModels = () => {
    const input = preview(false)
    if (!input || operation.current) return
    void run('正在读取可用模型…', async (signal) => {
      const result = await client.models(input, signal)
      if (!alive.current || signal.aborted) return
      setModels(result.models.filter((model) => isTextModelSuggestion(model.id))); setModelSource(result.source)
      setNotice(result.source === 'provider' ? '已读取账号模型列表。请选择文字模型，也可以直接填写其他模型名称。' : '当前服务未提供模型列表，显示常见文字模型；你仍可以手动填写模型名称。')
    })
  }

  const pause = () => {
    if (!status) return
    void run('正在暂停新分析…', async (signal) => {
      const next = await client.pause({ version: 1, expectedRevision: status.revision }, signal)
      if (!alive.current || signal.aborted) return
      adopt(next); setNotice('已暂停新的分析。已有任务仍可恢复查看。'); onConnected()
    })
  }

  const connectManualModel = () => {
    if (!status) return
    void run('正在连接手填模型…', async (signal) => {
      const next = await client.enable({ version: 1, expectedRevision: status.revision }, signal)
      if (!alive.current || signal.aborted) return
      adopt(next)
      if (next.enabled && next.acceptsRuns) { setNotice('手填模型已连接。生成效果将在你开始分析后验证。'); onConnected() }
      else setError(statusMessage(next))
    })
  }

  const forget = () => {
    if (!status) return
    setApiKey('')
    void run('正在删除本机连接配置…', async (signal) => {
      const next = await client.forget({ version: 1, expectedRevision: status.revision }, signal)
      if (!alive.current || signal.aborted) return
      adopt(next); setForm(initialForm); setModels([]); setNotice('本机连接配置和密钥已删除。文档与已有分析结果仍保留。'); onConnected()
    })
  }

  const preset = getProviderPreset(form.providerId)
  const catalogModels = preset?.models ?? []
  const choices = [...new Map([...catalogModels, ...models].map((model) => [model.id, model])).values()]
  const unavailable = status?.available === false
  const disabled = Boolean(busy) || unavailable || !status
  const savedKey = canReuseSavedProviderKey(status, form)
  const isCustom = form.providerId === 'custom'
  const draftChanged = Boolean(status?.configured && (apiKey || status.providerId !== form.providerId || status.baseUrl !== form.baseUrl || status.modelId !== form.modelId || status.protocol !== form.protocol || status.structuredOutput !== form.structuredOutput || status.networkMode !== form.networkMode))
  const onSubmit = (event: FormEvent) => { event.preventDefault(); save(true) }
  const trapTab = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== 'Tab') return
    const elements = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]'))
      .filter((element) => element.getClientRects().length > 0)
    const first = elements[0], last = elements.at(-1)
    if (!first || !last) return
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }

  return <dialog className="ai-settings-panel" ref={dialog} aria-labelledby="ai-settings-title" data-analysis-panel
    onCancel={onClose} onKeyDown={trapTab} onClick={(event) => { if (event.target === event.currentTarget) {
      const rect = event.currentTarget.getBoundingClientRect()
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose()
    } }}>
    <header className="modal-head"><div><h2 id="ai-settings-title">连接你的 AI</h2><p>选服务、填密钥、选模型，然后回到文档。</p></div>
      <button className="tbtn" onClick={onClose} aria-label="关闭 AI 设置">✕</button></header>
    <div className="ai-settings-body">
      <section className="ai-connection-status" data-state={error ? 'error' : status?.enabled && status.acceptsRuns ? 'success' : 'default'} aria-label="AI 连接状态">
        <strong>{!status && error ? '暂时无法连接 AI 服务' : statusLabel(status)}</strong>
        {status && <p>{statusMessage(status)}</p>}
        {status?.configured && <p>已保存模型：{status.modelId}</p>}
        {draftChanged && <p>表单有未保存的修改。保存后需重新连接，新的分析才会使用这些设置。</p>}
        {busy && <p role="status">{busy}</p>}
        {error && <p role="alert" className="analysis-error">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        <button className="tbtn" disabled={Boolean(busy)} onClick={readStatus}>重新连接</button>
        {status?.configured && status.messageKey === 'analysis.personal.models_not_supported' && !draftChanged && !status.enabled && <button className="tbtn primary ai-manual-connect" disabled={Boolean(busy)} onClick={connectManualModel}>使用手填模型连接</button>}
      </section>
      {!unavailable && <form onSubmit={onSubmit} autoComplete="off">
        <fieldset disabled={disabled} className="ai-settings-fields"><legend className="sr-only">AI 连接配置</legend>
          <label className="ai-field"><span>AI 服务</span><select ref={providerSelect} value={getProviderPreset(form.providerId) ? form.providerId : 'custom'}
            aria-label="AI 服务" onChange={(event) => selectProvider(event.target.value)}>
            {PROVIDER_CATALOG.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
          </select><small>{preset?.note ?? '可以使用常见服务，也可以添加兼容的 AI 服务。'}</small></label>
          {isCustom && <label className="ai-field"><span>API 服务地址</span><input type="url" aria-label="API 服务地址" value={form.baseUrl}
            placeholder="https://你的服务地址/v1" maxLength={2048} onChange={(event) => changeBaseUrl(event.target.value)} />
            <small>{form.networkMode === 'local-loopback' ? '已识别为本机地址。连接只会发往当前电脑。' : '可填基础地址，也可粘贴完整接口地址；会自动识别接口格式。'}</small></label>}
          <label className="ai-field"><span>API 密钥{savedKey ? ' · 已保存在本地服务' : preset?.requiresApiKey === false ? ' · 可留空' : ''}</span>
            <input type="password" name="cat-thinking-ai-key" aria-label="API 密钥" value={apiKey} autoComplete="new-password" spellCheck={false}
              maxLength={4096} placeholder={savedKey ? '留空继续使用已保存的密钥' : '粘贴服务商提供的 API 密钥'}
              onChange={(event) => setApiKey(event.target.value)} aria-describedby="ai-key-help" />
            <small id="ai-key-help">密钥由本地 AI 服务保管，浏览器文档和备份不含密钥。</small>
          </label>
          <div className="ai-model-field"><label className="ai-field"><span>模型</span><input aria-label="AI 模型" value={form.modelId} list="ai-model-choices"
            maxLength={200} placeholder="选择或输入模型名称" spellCheck={false} onChange={(event) => setForm({ ...form, modelId: event.target.value })} />
            <small>请选择文字模型。可搜索或手动填写，是否可用以你的账号为准。</small></label>
            <button type="button" className="tbtn" onClick={refreshModels}>读取可用模型</button></div>
          <datalist id="ai-model-choices">{choices.map((model) => <option key={model.id} value={model.id}>{model.label ?? model.id}</option>)}</datalist>
          {choices.length > 0 && <div className="ai-model-presets" aria-label={modelSource === 'provider' ? '文字模型选择参考' : '常见文字模型'}>
            {choices.slice(0, 6).map((model) => <button type="button" key={model.id} className={'tbtn ai-model-choice' + (form.modelId === model.id ? ' on' : '')}
              aria-pressed={form.modelId === model.id} title={model.id} onClick={() => setForm({ ...form, modelId: model.id })}>{model.label ?? model.id}</button>)}
          </div>}
          {modelSource === 'provider' && form.modelId && !models.some((model) => model.id === form.modelId) && <p className="ai-billing-note">当前填写的模型未出现在账号模型列表中。可以继续使用手填名称，是否可用以实际分析为准。</p>}
          <details className="ai-settings-advanced"><summary>更多连接选项</summary><p>常见服务已预设。只有服务商给出不同地址或接口格式时才需要修改。</p>
            {!isCustom && <label className="ai-field"><span>API 服务地址</span><input type="url" aria-label="API 服务地址" value={form.baseUrl} maxLength={2048}
              onChange={(event) => changeBaseUrl(event.target.value)} /><small>支持基础地址和完整接口地址；自动识别明确的接口格式。</small></label>}
            <div className="ai-settings-grid">
              <label className="ai-field"><span>接口格式</span><select aria-label="接口格式" value={form.protocol} onChange={(event) => setForm({ ...form, protocol: event.target.value as ProviderProtocol })}>
                <option value="chat-completions">聊天接口（广泛兼容）</option><option value="responses">Responses 接口</option></select></label>
              <label className="ai-field"><span>结果格式</span><select aria-label="结果格式" value={form.structuredOutput} onChange={(event) => setForm({ ...form, structuredOutput: event.target.value as ProviderStructuredOutput })}>
                <option value="json_schema">严格格式</option><option value="json_object">兼容格式</option></select></label>
            </div>
            <label className="ai-field"><span>服务位置</span><select aria-label="服务位置" value={form.networkMode} onChange={(event) => setForm({ ...form, networkMode: event.target.value as ProviderNetworkMode })}>
              <option value="public">互联网 AI 服务</option><option value="local-loopback">本机 AI 服务</option></select><small>本机服务仅允许当前电脑的回环地址，不能用于访问其他内网设备。</small></label>
            {status && <p className="ai-guardrail-note">每次分析默认限制原文长度、模型输出和调用次数，避免意外消耗。费用以服务商账单为准。</p>}
          </details>
          <p className="ai-billing-note">连接检查只读取模型列表，不生成内容。正式分析会使用你的服务商额度，生成效果将在首次任务中验证。</p>
          <div className="ai-settings-actions"><button className="tbtn primary" type="submit">保存并连接</button>
            <button className="tbtn" type="button" onClick={() => save(false)}>只保存，暂不分析</button></div>
        </fieldset>
      </form>}
      {status?.available && status.configured && <div className="ai-settings-maintenance">
        <button className="tbtn" disabled={Boolean(busy) || !status.enabled} onClick={pause}>暂停新分析</button>
        <button className="tbtn danger" disabled={Boolean(busy)} onClick={() => setConfirmForget(true)}>删除连接与密钥</button>
      </div>}
      {confirmForget && <section className="ai-forget-confirm" role="group" aria-label="确认删除 AI 连接">
        <p>删除本机保存的 AI 连接与密钥，并暂停新分析。文档和已有分析结果仍保留。</p>
        <div className="ai-settings-actions"><button className="tbtn danger" disabled={Boolean(busy)} onClick={forget}>确认删除连接</button>
          <button className="tbtn" onClick={() => setConfirmForget(false)}>保留连接</button></div>
      </section>}
      {status?.enabled && status.acceptsRuns && <button className="tbtn primary ai-return" onClick={onClose}>回到文档</button>}
    </div>
  </dialog>
}

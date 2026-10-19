import type { PersonalProviderModel, ProviderNetworkMode, ProviderProtocol, ProviderStructuredOutput } from './providerSettings.js'

export interface ProviderPreset {
  readonly id: string
  readonly label: string
  readonly baseUrl: string
  readonly protocol: ProviderProtocol
  readonly structuredOutput: ProviderStructuredOutput
  readonly networkMode: ProviderNetworkMode
  readonly tokenParameter: 'max_tokens' | 'max_completion_tokens'
  readonly requiresApiKey: boolean
  readonly models: readonly PersonalProviderModel[]
  readonly documentationUrl: string
  readonly note?: string
  /** Some gateways only document plain chat; keep schema instructions and validate locally. */
  readonly promptOnlyJson?: boolean
  readonly verifiedAt: string
}

const preset = (input: Omit<ProviderPreset, 'verifiedAt'> & { verifiedAt?: string }): ProviderPreset => Object.freeze({
  ...input,
  models: Object.freeze(input.models.map((model) => Object.freeze({ ...model }))),
  verifiedAt: input.verifiedAt ?? '2026-10-12',
})

// Suggestions are a dated documentation snapshot, not an account entitlement.
// Model discovery and manual entry remain available when vendors change aliases.
export const PROVIDER_CATALOG: readonly ProviderPreset[] = Object.freeze([
  preset({
    id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1',
    protocol: 'responses', structuredOutput: 'json_schema', networkMode: 'public',
    tokenParameter: 'max_completion_tokens', requiresApiKey: true,
    models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' }, { id: 'gpt-6-luna', label: 'GPT-6 Luna' }, { id: 'gpt-6-astra', label: 'GPT-6 Astra' }],
    documentationUrl: 'https://developers.openai.com/api/docs/models',
  }),
  preset({
    id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com',
    protocol: 'chat-completions', structuredOutput: 'json_object', networkMode: 'public',
    tokenParameter: 'max_tokens', requiresApiKey: true,
    models: [{ id: 'deepseek-flash', label: 'DeepSeek Flash' }, { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }],
    documentationUrl: 'https://api-docs.deepseek.com/',
  }),
  preset({
    id: 'mobilecloud', label: '移动云 MoMA · DeepSeek', baseUrl: 'https://zhenze-huhehaote.cmecloud.cn/v1',
    protocol: 'chat-completions', structuredOutput: 'json_object', networkMode: 'public',
    tokenParameter: 'max_tokens', requiresApiKey: true, promptOnlyJson: true,
    models: [{ id: 'deepseek-v4-flash-0731', label: 'DeepSeek V4 Flash · 0731' }],
    documentationUrl: 'https://ecloud.10086.cn/api/page/maas/moma/modelSquare/modelSquareDetails?modelName=DeepSeek-V4-Flash-0731',
    note: '按移动云控制台调用示例配置。使用移动云 API Key；其他地域请修改服务地址，模型权限与费用以你的账号为准。',
    // User supplied the official console example on this date; no account access implied.
    verifiedAt: '2026-10-17',
  }),
  preset({
    id: 'qwen', label: '通义千问 · 阿里云百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    protocol: 'chat-completions', structuredOutput: 'json_object', networkMode: 'public',
    tokenParameter: 'max_tokens', requiresApiKey: true,
    models: [{ id: 'qwen3.7-plus', label: 'Qwen3.7 Plus' }, { id: 'qwen3.8-flash', label: 'Qwen3.8 Flash' }, { id: 'qwen3.8-max', label: 'Qwen3.8 Max' }],
    documentationUrl: 'https://help.aliyun.com/zh/model-studio/qwen-structured-output',
    note: '默认北京地域通用 API。其他地域或工作空间可修改地址；Coding Plan 密钥须使用对应的专用地址。',
  }),
  preset({
    id: 'moonshot', label: 'Kimi · 月之暗面', baseUrl: 'https://api.moonshot.cn/v1',
    protocol: 'chat-completions', structuredOutput: 'json_object', networkMode: 'public',
    tokenParameter: 'max_tokens', requiresApiKey: true,
    models: [{ id: 'kimi-k2.6', label: 'Kimi K2.6' }, { id: 'kimi-k3', label: 'Kimi K3' }],
    documentationUrl: 'https://platform.kimi.com/docs/api/chat',
    note: '默认中国区 API；国际账号请改用对应地域地址。',
  }),
  preset({
    id: 'zhipu', label: 'GLM · 智谱', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    protocol: 'chat-completions', structuredOutput: 'json_object', networkMode: 'public',
    tokenParameter: 'max_tokens', requiresApiKey: true,
    models: [{ id: 'glm-5.2', label: 'GLM-5.2' }, { id: 'glm-5.3', label: 'GLM-5.3' }],
    documentationUrl: 'https://docs.bigmodel.cn/cn/guide/develop/openai/introduction',
    note: '使用通用开放平台密钥；Coding Plan 套餐地址与通用地址不同。',
  }),
  preset({
    id: 'siliconflow', label: '硅基流动 · SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1',
    protocol: 'chat-completions', structuredOutput: 'json_object', networkMode: 'public',
    tokenParameter: 'max_tokens', requiresApiKey: true,
    models: [{ id: 'Pro/zai-org/GLM-5.1', label: 'GLM-5.1 · Pro' }],
    documentationUrl: 'https://docs.siliconflow.cn/docs/userguide/guides/json-mode',
    note: '可刷新账号当前模型列表；不同模型支持的输出格式可能不同。',
  }),
  preset({
    id: 'gemini', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    protocol: 'chat-completions', structuredOutput: 'json_schema', networkMode: 'public',
    tokenParameter: 'max_tokens', requiresApiKey: true,
    models: [{ id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' }],
    documentationUrl: 'https://ai.google.dev/gemini-api/docs/openai',
    note: '使用 Gemini API 密钥和官方 OpenAI 兼容接口。',
  }),
  preset({
    id: 'ollama', label: 'Ollama · 本机模型', baseUrl: 'http://127.0.0.1:11434/v1',
    protocol: 'chat-completions', structuredOutput: 'json_object', networkMode: 'local-loopback',
    tokenParameter: 'max_tokens', requiresApiKey: false, models: [],
    documentationUrl: 'https://docs.ollama.com/api/openai-compatibility',
    note: '须先在本机运行 Ollama 并下载模型，再刷新或手填已安装的模型名称。',
  }),
  preset({
    id: 'custom', label: '自定义 OpenAI 兼容 API', baseUrl: '',
    protocol: 'chat-completions', structuredOutput: 'json_object', networkMode: 'public',
    tokenParameter: 'max_tokens', requiresApiKey: true, models: [],
    documentationUrl: 'https://developers.openai.com/api/reference/resources/chat/methods/create',
    note: '填写服务商提供的 HTTPS 地址和模型名称。Anthropic 原生 API 需要独立适配，请勿直接填写 /messages 接口。',
  }),
])

export const getProviderPreset = (id: string): ProviderPreset | undefined => PROVIDER_CATALOG.find((entry) => entry.id === id)

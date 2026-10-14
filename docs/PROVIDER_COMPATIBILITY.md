# API 与模型兼容说明

核验日期：2026-10-12。预设是官方文档中公开列出的示例，不代表某个账号必然有权限、余额或该模型的地区访问资格。用户可以刷新账号模型列表或手动输入服务商给出的模型名称。

## 用户需要填写什么

普通服务商：选择服务商，填写 API 密钥，选择或输入模型。预设自动填入接口地址和兼容方式。

自定义服务商：额外填写服务商提供的 HTTPS 地址。可以粘贴基础地址，也可以粘贴完整的 `/chat/completions` 或 `/responses` 地址。应用统一整理路径，不重复追加 `/v1`。与预设对应的官方域名只填写域名时，也会补入已知的基础路径。

Ollama：先自行在本机安装并运行 Ollama、下载模型，再选择本机服务并刷新模型列表。不需要 API 密钥。此入口只接受 `localhost`、`127.0.0.1` 或 `::1`，不用于访问局域网其他机器。

保存设置和检测连接不进行付费生成。连接检测只读取模型列表；实际生成能力和输出格式会在用户第一次生成内容时，由原有内容校验流程确认。若服务商明确不提供模型列表接口（HTTP 404/405），用户仍可手填模型。认证失败、超时、限流或其他错误不算检测通过。

## 当前预设

| 服务商 | 接口类型 | 默认输出模式 | 模型示例与官方文档 |
| --- | --- | --- | --- |
| OpenAI | Responses | JSON Schema | [GPT-6.1 Sol、GPT-6 Luna、GPT-6 Astra](https://developers.openai.com/api/docs/models) |
| DeepSeek | Chat Completions | JSON Object | [deepseek-flash、deepseek-v4-pro](https://api-docs.deepseek.com/)；[JSON 输出说明](https://api-docs.deepseek.com/guides/json_mode/) |
| 通义千问 / 阿里云百炼 | Chat Completions | JSON Object | [qwen3.7-plus、qwen3.8-flash、qwen3.8-max 与结构化输出说明](https://help.aliyun.com/zh/model-studio/qwen-structured-output) |
| Kimi / 月之暗面 | Chat Completions | JSON Object | [kimi-k2.6、kimi-k3 与 JSON 格式说明](https://platform.kimi.com/docs/api/chat) |
| GLM / 智谱 | Chat Completions | JSON Object | [glm-5.3、glm-5.2 与兼容接口](https://docs.bigmodel.cn/cn/guide/develop/openai/introduction)；[结构化输出说明](https://docs.bigmodel.cn/cn/guide/capabilities/struct-output) |
| 硅基流动 / SiliconFlow | Chat Completions | JSON Object | [Pro/zai-org/GLM-5.1 与 JSON 模式](https://docs.siliconflow.cn/docs/userguide/guides/json-mode) |
| Google Gemini | 官方 Chat Completions 兼容接口 | JSON Schema | [gemini-3.8-flash、模型列表与结构化输出](https://ai.google.dev/gemini-api/docs/openai) |
| Ollama | 本机 Chat Completions 兼容接口 | JSON Object | [已安装模型与兼容接口](https://docs.ollama.com/api/openai-compatibility) |
| 自定义 | Chat Completions 或 Responses | 可选 | 手工填写模型；支持 OpenAI 兼容服务 |

阿里云默认使用北京地域通用接口。官方说明旧的 `dashscope.aliyuncs.com` 地址继续可用，也支持用户填入工作空间专用地址；其他地区需使用匹配的密钥与地址。[阿里云接口迁移说明](https://help.aliyun.com/en/model-studio/compatibility-with-openai-responses-api)

服务商的编程订阅套餐与通用 API 密钥、地区密钥可能对应不同地址，不能相互混用。高级设置允许修改地址。Anthropic 原生 `/messages`、Azure 独有身份认证/部署路径和未经适配的第三方原生协议目前不在此兼容范围；只有确实提供 OpenAI 兼容接口的代理可走自定义入口。

## 开发边界

- `packages/analysis-contracts/src/providerCatalog.ts` 集中维护日期、模型建议和公开文档。新增同协议服务商主要追加预设，页面和业务流程无需复制生成逻辑。
- `providerSettings.ts` 是设置、模型列表和状态的严格共享契约。状态只返回 `hasApiKey`，拒绝任何密钥字段；模型列表检测不要求先填写模型。
- `personalModelProvider.ts` 把设置转换为既有 `ModelProvider`。个人模式默认每次输出最多 4,096 token，每个任务最多 200,000 token、24 次调用；内容输入上限 100,000 字符。金额未知时返回 `pricingKnown=false`，界面不显示内部的占位金额为免费。
- `openAICompatibleProvider.ts` 保留部署模式原有严格输出行为。个人模式按预设使用 `max_tokens` 或 `max_completion_tokens`，不发送部分推理模型不接受的温度参数。JSON Object 模式把输出 Schema 明确放入指令，全部结果继续通过既有 coordinator、validator 和独立 repair invocation。
- 对文档已明确支持开关的预设模型（DeepSeek Flash/V4 Pro、Kimi K2.6、Qwen3.7 Plus/Qwen3.8 Flash/Max），默认关闭额外思考，优先完成材料提取和内容整理，减少等待和推理 Token。未知模型和始终思考的模型保留服务商默认行为，不盲目追加不兼容参数。[DeepSeek 思考开关](https://api-docs.deepseek.com/guides/thinking_mode/)、[Kimi 参数](https://platform.kimi.com/docs/api/chat)、[Qwen 思考开关](https://help.aliyun.com/zh/model-studio/deep-thinking)
- 网络超时、断线和无法确认是否已接受的 POST 不自动重发，也不为尝试另一种格式重复付费。响应缺少可信用量时，保留“已接受、用量未确认”的失败事实，不伪造零 token。用户需要处理失败并决定后续操作。
- `providerConnection.ts` 限制公开模式为 HTTPS，禁止地址携带用户名、密码、查询参数或片段；阻止私有/保留 IP、云元数据地址、IPv4 映射 IPv6 和内部主机名。每次连接检查全部 DNS 地址，并将实际 socket 固定到一个已检查的地址；TLS 仍验证原服务商域名。它不跟随重定向，不使用代理环境变量转发密钥；响应、模型列表、超时和取消都有明确上限。
- 基础测试全部使用 fake response 或本机临时 HTTP fixture。公开文档核验不代表已调用真实生成 API，实际密钥与账号兼容性仍须在用户提供设置后确认。

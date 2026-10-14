# 真实 Provider 接入准备与交接

默认 Provider 为 `disabled`，`ANALYSIS_RELEASE_HOLD=true`，`acceptsRuns=false`。完成本地准备不会发起真实调用或解除 hold。Windows 原生 PostgreSQL 已可独立运行，不需要云端账号；测试、smoke 与本地业务库分别为 `cat_analysis_test`、`cat_analysis_smoke`、`cat_analysis_local`。保护目录中的密码和内容加密密钥不能重新生成，否则旧内容可能无法解密。

## 先完成配置只读检查

使用已有、经验证的服务构建执行：

```powershell
npm run prepare:provider
npm run prepare:provider:local
npm run prepare:provider:local -- --config D:\protected\provider-only.json
```

这些命令不会连接数据库、启动服务/dispatcher、调用 Provider 或签发 release proof。缺少条件时底层脚本退出码为 2；本机 npm 包装命令会映射为 1，仍以 JSON `status=blocked` 判断。输出只包含检查名称和结果。`postgres` 表示配置已选择 PostgreSQL，不代表连接和恢复已经实测通过。命令不会自动重建构件，以免改变 CI 证明绑定的 build digest。初次构建可单独执行 `npm run build:service`；正式验证必须使用 CI 签名绑定的同一份不可变构件。

完整配置文件格式见 `provider-preparation.example.json`：`version: 1` 和字符串值 `environment` 对象。`prepare:provider -- --config <path> --report <new-path>` 将该文件视为完整配置，不继承环境中的 Provider/hold 设置，报告文件只允许新建。`prepare:provider:local` 只接收 Provider 配置、保护证明/签名/checkpoint 路径及 smoke 显式授权、执行标识与外层预算；数据库、认证、来源与 hold 由现有本地保护配置固定。它使用本地业务库，因此 smoke_database 检查保持阻塞；专用 smoke 验证应另用完整配置，不能靠只读准备命令改业务库。不要把密钥写进命令行参数、仓库、报告或聊天。

尚需由部署者选择并在保护环境填写：批准的 HTTPS endpoint 和精确 allowed host、Provider/model/profile、请求样式、密钥、保守输入/输出价格、显式 run token/费用上限。保护验证要求 `ANALYSIS_PROVIDER_MAX_ATTEMPTS=1`。这里没有默认真实模型价格；选择具体 Provider 后应核对其官方配置和计价，再确定边界。

## 获得实际 Ubuntu CI 证明

Quality workflow 的普通任务覆盖 Windows 质量、Ubuntu 浏览器、生产构建性能、容器、PostgreSQL 恢复与脱敏 fixture。手动运行 main 上的 `sign_release_prerequisites=true` 会额外执行受保护 `analysis-release` environment 的完整验证；需配置匹配的 Ed25519 私钥、公钥 secrets 和该 environment 的保护规则。此任务不需要 Provider 密钥，也不会调用真实 Provider。

`npm run verify:ci:sign` 只能在实际 Linux GitHub Actions、干净 checkout、独立 `cat_analysis_test`、显式 `ANALYSIS_CI_SIGNING=I_ACKNOWLEDGE_TRUSTED_CI_SIGNING` 和外部保护签名路径下运行。它自行运行质量、无跳过的 PostgreSQL/覆盖率、两种 dependency audit、普通与五产物浏览器恢复、容器检查，成功后签发独立 audience 的 CI prerequisites。普通 JSON、虚构 passed 字段、过期签名或其他 build 均无效。有效期最多 24 小时；工件包含对应服务/contracts 构件、公钥和签名，不上传私钥。未经实际运行的 workflow 不能当作已通过证据。

本机 WSL 的 Ubuntu 注册项因 `HCS_E_HYPERV_NOT_INSTALLED` 无法启动，Docker CLI 不可用，因此本地 Windows 通过不能替代实际 Ubuntu/container CI。未自动修改系统虚拟化功能或重启机器。

## B6.1 第一次真实调用：专用 smoke

配置 ready 后才执行 `npm run test:provider:live`，保持 hold。必须显式设置：

- `ANALYSIS_LIVE_SMOKE=I_ACKNOWLEDGE_BILLABLE_SYNTHETIC_SMOKE`。
- `ANALYSIS_LIVE_SMOKE_MAX_ESTIMATED_TOKENS` 和 `ANALYSIS_LIVE_SMOKE_MAX_ESTIMATED_COST_MICROS`：正整数，最大分别为 200000、1000000；它们只会收紧 run 预算。
- 同一 `cat_analysis_smoke` 的配置 store 与 `ANALYSIS_TEST_DATABASE_URL`；`ANALYSIS_RECOVERY_TEST_DATABASE_URL` 必须指向另一个 `cat_analysis_test`，fake recovery/coverage 只清空该测试库，绝不清空真实 smoke 账本。
- 稳定的 32 位小写 hex `ANALYSIS_LIVE_SMOKE_EXECUTION_ID`，外部绝对路径 `ANALYSIS_LIVE_SMOKE_CHECKPOINT_PATH`；中断和重复执行复用该标识/checkpoint，不随机重开付费 run。
- 新鲜 CI prerequisites、匹配的 Ed25519 公私钥、release 输出保护路径及干净 exact-build checkout。缺少签名材料即阻塞，防止无持久可信 checkpoint 的付费执行。

Smoke 使用公开合成材料，覆盖 Evidence、Summary、Outline、MindMap、Quiz、Knowledge，经同一 coordinator/validator/dispatcher 并汇总 ledger。新验证由操作者显式提供 nonce，防止把 fake cache 当作真实成功；恢复保持原 nonce。复用 target 核心在内容清理前写入签名 checkpoint，真实 smoke ledger 始终保留。最终证据须经过重新连接、usage 对账和内容清理；unknown 不能当作零费用或自动重放。失败保持关闭，不通过增加重试掩盖问题。Smoke 的配置 hash 不能用于放行其他数据库。

## B6.2–B6.3 目标验证与恢复

先审核真实 smoke 的格式、grounding、usage 和失败行为，再执行 `npm run test:provider:target`。它是一项独立的真实付费验证：

- 使用目标实际配置、hold=true、maxAttempts=1、当前 schema；只读校验 schema 版本，不自动迁移。
- 显式 `ANALYSIS_TARGET_VALIDATION=I_ACKNOWLEDGE_BILLABLE_NONDESTRUCTIVE_TARGET_VALIDATION`。
- `ANALYSIS_TARGET_VALIDATION_EXECUTION_ID` 为 32 位小写 hex；中断后复用同一值，不换 nonce 重跑。
- 显式 `ANALYSIS_TARGET_VALIDATION_MAX_ESTIMATED_TOKENS`、`ANALYSIS_TARGET_VALIDATION_MAX_ESTIMATED_COST_MICROS`，同样只能收紧原 run 预算。
- 五个互异绝对外部路径：`ANALYSIS_CI_PREREQUISITES_PATH`、`ANALYSIS_RELEASE_PUBLIC_KEY_PATH`、`ANALYSIS_RELEASE_SIGNING_KEY_PATH`、`ANALYSIS_RELEASE_ATTESTATION_PATH`、`ANALYSIS_TARGET_VALIDATION_CHECKPOINT_PATH`。

验证只发现并执行自身 synthetic tenant/run，不运行 TRUNCATE 或全局过期清理，保留业务内容与账本。签名 checkpoint 绑定 build/config/nonce，支持已完成内容清理后的恢复，不重复成功或 unknown 调用。Unknown 会保持阻塞，留待人工向 Provider 对账。成功签发的 target proof 也不会修改 hold。

Checkpoint 在发布前刷盘文件，POSIX 平台还同步父目录。Windows 的 Node 接口没有可移植的目录 fsync，因此 Windows 的文件 checkpoint 验证范围是进程中断恢复，不能承诺机器断电恢复；如果断电后 checkpoint 丢失而内容已清理，同 nonce 保持关闭并需人工核验，不自动重放付费调用。PostgreSQL ledger 的事务与聚合仍是账务事实来源；此边界不能用重新随机生成 nonce 绕过。

## B6.4 放行与观察

只有目标 store、Provider、dispatcher、usage、recovery、真实 CI 和 exact-build target proof 全部通过，才可在独立发布步骤解除 hold，并验证 `acceptsRuns=true`。首次放行应限制规模，观察拒绝、取消、耗时、known/unknown usage 和恢复；移除或过期证明、重新启用 hold、Store/Provider 异常和停机会关闭 admission。已经发送的请求可能仍被计费，必须保留账本。

目前没有真实 Provider 配置、实际远端 CI 签名或真实调用证据，状态应继续为准备完成/外部门禁待办，而非 production ready。详细浏览器验收纪律见 [BROWSER_VALIDATION_DISCIPLINE.md](../../docs/BROWSER_VALIDATION_DISCIPLINE.md)。

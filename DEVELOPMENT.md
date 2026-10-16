# 猫思之开发说明

本仓库包含页面、本机 AI 后台、共享数据约定和测试。用户启动步骤见 [README](./README.md)。

## 环境与首次安装

- 完整本机启动脚本面向 Windows；Node.js 要求为 24.13.1 或更新的 24 系列版本，与后台的运行范围一致。
- 在仓库根目录执行 `npm.cmd ci`。依赖是多工作区统一安装，请保留 `package-lock.json`，不要分别复制各子目录的 node_modules。
- 源码 ZIP 必须全部解压，再运行启动文件。

## 两种开发入口

### 页面和本地学习

```powershell
npm.cmd run dev
```

默认打开 http://127.0.0.1:5173/。支持本地资料导入、原文入门题、已保存课程练习、导图和预设小猫引导。此入口不会启动数据库或模型后台，AI 接口不可用属于预期行为。端口被占用时请先停止自己的旧页面服务，或明确使用其他端口；浏览器数据按网址隔离。

### 完整本机应用

```powershell
npm.cmd run start:local
```

等价入口为 `启动猫思之.cmd`。脚本会在需要时下载 PostgreSQL、初始化数据库、编译后台、选择可用端口并启动页面。请使用窗口输出的网址；按 Ctrl+C 正常结束。首次准备需要网络，干净 Windows 电脑安装仍需接手者验收。

模型配置从应用内“AI 设置”完成。保存连接与读取模型列表不等于生成；用户明确点击生成才允许发送原文。预设伊希斯对话不调用模型。不要把个人密钥复制进源码、测试素材或文档。

数据库、加密配置和数据库备份保存在仓库旁的 `.cat-thinking-postgres`。这是本机运行数据，不需要从原开发者电脑拷贝，也不提交到仓库。数据库备份恢复不能等同于页面课程包恢复。

## 目录

| 目录或文件 | 用途 |
| --- | --- |
| `src/components/learning` | 学习首页、题目、补学、阅读与复习界面 |
| `src/learning` | 课程、会话、作答、复习、成就与课程包规则 |
| `src/onboarding` | 伊希斯预设对话与首次使用引导 |
| `src/analysis` | 页面侧分析任务与结果状态 |
| `src/lib`、`src/store` | 文档解析、导图工具与浏览器持久化 |
| `public/images/isis-cat.jpg` | 产品内使用的小猫原图，需随代码保留 |
| `packages/analysis-contracts` | 页面与后台共享的数据约定和校验 |
| `services/analysis-service` | AI 后台、模型适配、任务与数据库存储 |
| `scripts` | 启动、数据库、打包和验证工具 |
| `e2e`、`evals` | 页面测试、固定素材与模型质量检查工具 |

## 维护学习流程

- 新学习先显示题目；相关段落由用户请求后显示，完整阅读使用对应原文，不能只把引用片段当成全文。
- 阅读返回保留原题、草稿与步骤。保存进行中或失败时，不应绕过退出保护。
- 老会话保留原步骤；修改数据格式时同时考虑历史记录和课程包恢复。
- 首页和学习任务集中呈现，长题和长答案保持完整。管理、报告、设置与独立阅读允许正常滚动。
- 小猫使用页面预留位置，避免遮挡输入和按钮。当前为预设内容，不能把任意聊天描述成已接入 AI。
- 复习建议来自实际提交，用户明确采用；不要覆盖已有手动日期。成就只从真实记录计算。

## 常用检查

```powershell
npm.cmd run lint:ci
npm.cmd run typecheck
npm.cmd run typecheck:service
npm.cmd test -- --no-file-parallelism
npm.cmd run build
npm.cmd run verify:browser:build
npm.cmd run build:service
```

单元测试和页面测试不能代替真实模型、真实数据库与新电脑安装检查。真实模型检查可能产生费用，必须单独安排，不能因运行页面或查看结果自动触发。

首次运行页面测试，先安装测试浏览器：

```powershell
npm.cmd run e2e:install
npm.cmd run e2e
```

页面测试会自行启动专用页面服务。执行前停止占用测试端口的旧服务，端口和启动方式以对应 `playwright*.config.ts` 为准。涉及后台和数据库的测试入口见 [后台说明](./services/analysis-service/README.md)。

`npm.cmd run build` 只构建页面；`npm.cmd run preview` 只预览页面。生产发布还需要后台、网关和数据库配置，不能直接以预览服务替代。

## 排错与提交

- 依赖或 Node.js 检查：运行 `node scripts/startup-preflight.mjs`，或双击 `诊断启动.cmd`。
- 下载失败：保留报错后重试完整启动；下载脚本会校验归档并拒绝未验证的文件，不要跳过校验直接解压。
- `personal_profile_unavailable`：检查本机后台与应用内模型配置；不要删库或覆盖旧密钥来掩盖错误。
- 测试代码与固定测试素材需要提交；测试截图、测试结果、覆盖率、审计记录、设计方案和演示材料只在本地保留。
- `.env.example` 是无秘密的配置模板，可以提交；实际 `.env`、课程备份、数据库、密钥和用户原文不得混入提交。

后台接口与配置见 [AI 后台](./services/analysis-service/README.md)、[模型兼容说明](./docs/PROVIDER_COMPATIBILITY.md)、[共享约定](./packages/analysis-contracts/README.md)。

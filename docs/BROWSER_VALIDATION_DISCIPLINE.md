# 可重复的浏览器与构建验收

产品浏览器验收和构建必须在源码稳定后串行进行。`npm run e2e` 使用 5174 的独立 Vite 开发进程；AI 验收使用 5175 的独立 Vite 与 8790 的 fake dispatcher，并持有专用 PostgreSQL 测试库锁；生产性能验收使用 5176 的 `vite preview`，只读取已完成的 `dist`。这些端口独立，不能消除共享源码、contracts/dist 或构建产物变化造成的模块失效。

此前一次与全量构建并行的浏览器 run 在导入后显示欢迎文档，独立稳定运行未复现。可确认的干扰来源是共享 contracts/dist：`build:contracts` 重写浏览器也在读取的 workspace 输出；开发服务器会监视被依赖模块。另一个干扰来源是验收期间修改源码会触发 HMR，模块级的 App 初始化单飞状态可能随模块替换重置。没有保留足以证明具体失败由哪个事件引起的完整时间线；不得把其中任一因素写成已证实的唯一根因。

执行纪律：

1. 完成修改和 scoped 检查，停止工作区编辑。
2. 完成普通 CI 与全部构建，等待命令结束；不要在浏览器运行中重新生成 contracts、服务或 `dist`。
3. 串行执行普通浏览器、AI 假 Provider 浏览器、数据库恢复和生产性能验收；禁止复用已有服务器，保持 `retries: 0`。
4. 用 `node scripts/verify-browser-build.mjs` 验证 chunk 字节与生成指标一致，再用 `node node_modules/@playwright/test/cli.js test --config=playwright.performance.config.ts` 测量生产首屏、第一次/再次打开 AI，以及刷新后的文档/AI 恢复。
5. 保留失败快照、活动文档身份、脚本资源和完整命令时间线。隔离运行复现活动文档丢失时，按实际产品缺陷继续调查，不增加重试或把失败称为环境噪音。

`dist/build-metrics.json` 在 Vite 完成资源路径替换后记录 minified/gzip chunk 字节和静态/动态依赖；包 `renderedBytes` 是 Rollup 模块代码大小，位于最终压缩前，只供定位来源。验证器检查当前文件字节、所有静态 chunk 之间不存在循环，以及 AI 面板仍在首屏静态图之外。分包可以改善缓存和单个 chunk 大小，不能直接等同于首次加载总字节减少。性能附件使用公开合成 TXT，Provider 路由被本地 held fixture 截获，断言没有分析 POST，也没有页面脚本错误。10 秒上限仅用于发现挂起/严重退化，不代表真实网络或用户的响应时间承诺。既有 1050 节点、40 fps、完整 SVG 导出测试仍须保留。

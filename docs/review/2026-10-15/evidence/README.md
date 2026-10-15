# 定向复现记录

这些文件记录 **已发现的问题**，不是产品验收通过报告。基准源码为 `ec039649fe9f4b8729b977e819509910bf95cc2a`。修复后应另外新增回归测试与成功证据，不覆盖这里的原始失败事实。

| 文件 | 实际观察 | 边界 |
|---|---|---|
| [layout-observed.json](layout-observed.json) | SOL-USD/5m 切六图再单图，原图表 ID/配置消失并重建 NVDA/1D | 新 Chromium 上下文、demo 模式、API 请求全部阻断，实际 API 请求 0 次；不涉及用户工作区 |
| [runtime-observed.json](runtime-observed.json) | 相对/追踪退出没有绝对 limit/stop；反向成交反馈被接受；实时提醒历史在重启前后为空 | 前者是实际 Pine 输出加源码中的 Rust 市价映射，未提交该订单；后两者分别为真实 runtime 和隔离 Rust fixture 复现 |
| [reproduce-layout.cjs](reproduce-layout.cjs) | 可重跑浏览器状态变化诊断 | 仅指定独立测试前端；无 token，始终 demo 并阻断 API |
| [reproduce-runtime.py](reproduce-runtime.py) | Node/Pine 探针加临时 Rust SQLite 实例 | 使用已构建二进制、自建随机本机端口/临时 token；不继承数据商配置，输出不包含密钥；finally 清理临时实例 |
| [parent-verification.json](parent-verification.json) | 主 agent 重新运行两个可配置脚本，观察到相同问题 | 复核通过意味着问题可复现，不代表问题已经修复 |

脚本从原审查探针复制，并将机器路径改成可配置/相对路径。冻结的 `*-observed.json` 是原次运行结果；重跑输出另存。Python 只用于测试编排，默认软件运行仍为 Rust + React 与隔离 Node/PineTS。

在仓库根目录，已经安装锁定依赖、构建 Rust 二进制后：

```sh
python3 docs/review/2026-10-15/evidence/reproduce-runtime.py
```

输出默认写到 `var/review/runtime-observed.json`。如改变源码，应重建 Rust，检查输出记录的源码和二进制身份。

浏览器探针需要独立的已构建前端，以及额外测试环境中的 Playwright：

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright \
BROWSER_EXECUTABLE=/absolute/path/to/chromium \
TICKGROVE_REVIEW_URL=http://127.0.0.1:18892 \
node docs/review/2026-10-15/evidence/reproduce-layout.cjs
```

默认结果在 `/tmp/tickgrove-layout-review-latest.json`。`success` 仅表示诊断脚本执行完成；`reproducedStateLoss: true` 表示问题存在。未来修复验证需断言旧 chart ID 与用户设置保留，不能把诊断脚本 exit 0 当作产品通过。

quote→alert 和 cursor→order intent 的崩溃窗口仅由本轮源码审查确认，尚未做故障注入，不将它们列为已运行的 crash 测试。

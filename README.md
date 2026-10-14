# Trading Dashboard

React/TypeScript + Rust 自托管交易工作台。默认工作区连接 Rust 服务的行情、账户、提醒和持久任务；CLI、Web 与 Rust MCP 桥调用同一认证接口。功能验收状态见 [功能清单](docs/features/checklist.csv)。

运行架构：React 负责前端；Rust（Axum/Tokio/SQLite）负责 HTTP API、数据源订阅、历史数据、交易账户、订单、提醒、存储和任务调度；PineTS 与当前 Composer 策略计算器在受限 Node.js 进程中执行，由 Rust 调度并保存结果。当前不是全 Rust 的 Pine 编译器或全 Rust 策略计算引擎。正式服务、Web 和 Paseo 启动均不依赖 Python；仓库中的 Python 用于开发验收、网络探针、离线日历生成及可选 Python SDK。

## 当前版本与操作入口

这是可运行的开发版本，尚未完成全部功能验收。Charts 用于看盘和手动模拟交易；Scripts 支持粘贴或导入 `.pine`、原地编辑、添加/更新图表及同页查看回测；Pine `import` 模块在脚本文件菜单的 Pine dependencies 中管理。Data 配置来源和历史范围，Automation 选择已保存策略和快照进行持续模拟；tick/外部成交 Host、Composer 与开发接口在进阶入口中。四图/六图按面板宽度折叠次要操作，字体随应用提供。

最新审查：[96项功能与交互审查](docs/review/interaction-audit-2026-10-14.md)、[数据来源与存储架构](docs/review/data-and-storage-2026-10-14.md)。本轮前端验收见 [布局与Pine导入](docs/acceptance/ux-review.json) 和 [操作流程与手机布局](docs/acceptance/ux-flows.json)。公开行情、本地模拟、券商联网验收和 TradingView 等价性分别记录，不能互相替代。

## Paseo 远程预览

项目提供 `paseo.json`：在 Paseo 的 Scripts 中先启动 `trading`，需要外部 HTTPS 入口时再启动 `trading-share`。后者需要本机安装 `cloudflared`，会在自己的终端输出临时 `trycloudflare.com` 地址。远程客户端的 localhost 指向客户端本机，不能把服务器 localhost 地址直接当作远程入口。

预览数据单独保存在 `var/paseo-preview`，登录令牌位于该目录的 `auth-token` 文件；应用 API 保持 Bearer 认证。Node.js 启动器启动 Rust 服务，不继承券商凭据或其他工作区的环境密钥。公共行情不需要密钥；导入的合成示例始终单独标注。行情面板分别显示来源、延迟策略、事件时间和接收时间。

分享地址随隧道重启而改变。停止 Paseo 中的 `trading-share` 即关闭外部入口；停止 `trading` 即关闭预览服务。若服务重启后端口变化，也要重启分享脚本。临时隧道用于试用，长期部署应配置稳定域名与入口鉴权。

## 自托管服务（无密钥示例）

需要 Linux、Node.js 22.12+、Rust 1.90、bubblewrap 和启用的用户 namespace。首版默认单实例 SQLite；所有服务状态在 `var`。项目没有使用其它项目的账户凭据。

```sh
corepack pnpm install --frozen-lockfile --ignore-scripts --ignore-workspace
npm run build
CARGO_BUILD_JOBS=1 CARGO_PROFILE_DEV_DEBUG=0 cargo build --locked --manifest-path server/Cargo.toml --bins
TRADING_ROOT="$PWD" TRADING_BIND=127.0.0.1:8471 server/target/debug/trading-service
```

打开 http://127.0.0.1:8471 ，从 `var/auth-token` 读取实例令牌后连接。通过搜索选择数据源覆盖的任意标的，在 Data 中选择历史范围和会话；原图表、自选、Pine 编辑器、回测和手动模拟账户已接服务器。Composer 多资产快照在 Data 的 Portfolio 区域加载，再到 Automation 选择策略版本和快照。示例标的不是白名单。纯合成演示仅通过 `?mode=demo` 进入。

Coinbase 使用动态产品目录、公开历史和 WebSocket；Yahoo 提供股票/ETF 历史和公共推送，但交易所延迟及完整性不作保证，其报价不能用于本地自动成交。美股模拟成交以及 IEX/SIP 源需要专用 Alpaca 配置，尚未完成本项目的联网验收。隔夜适配还存在 WebSocket 端点版本、历史 feed 与连接复用缺口，不能称为已支持或仅待填写密钥。常规盘和扩展盘分别标识；扩展盘真实数据有缺口时保留诊断，不补合成价格，自动回测和部署拒绝有缺口的快照。

Automation 的持续模拟面板默认跟随所选快照的数据源，将新确认的收盘 K 线持续提交给 Pine 或 Composer；关闭网页后由 Rust 服务继续运行。Coinbase 收盘线默认等待 120 秒确认，图表的形成中 K 线仍随实时事件更新。历史缺口、来源变化或已提交成交被改写时停止推进并报告错误。也可明确选择导入事件模式或合成示例；每个追加事件持久化，重复 ID 不重复执行。只有验证成功才推进账本；失败、取消或中断的 pending 可重试或丢弃。该模式使用 Pine 原生历史撮合，不接外部成交。

独立的 Live Pine sessions 使用持续 Node 沙箱处理 tick、同根 K 线回滚和已验证的全局基础类型 `varip`。指标只计算和绘图；声明 `calc_on_every_tick=true` 的策略可选择共享 Rust 本地模拟账户，或通过有权限的 API 接收外部成交。实际成交反馈决定策略仓位，历史预热不执行订单。当前不支持实时跨数据集绑定、作用域内/复合类型 `varip` 或成交后递归计算；这些情况明确报错。参考本金不预留共享账户资金。停止会话会取消该会话尚未成交的本地订单，已有仓位仍留在账户内。

```sh
TRADING_URL=http://127.0.0.1:8471 server/target/debug/trading-cli system.capabilities
# MCP 使用同一服务，stdout 为正式协议流：
TRADING_URL=http://127.0.0.1:8471 server/target/debug/trading-mcp
```

Rust CLI 支持 `trading-cli METHOD [PARAMS.json | JSON] [--key IDEMPOTENCY_KEY]`。默认读取 `var/auth-token`，也可指定 `TRADING_TOKEN_FILE`。`scripts/trading.cjs` 保留为等价的可选 Node.js 客户端。

在线备份及恢复同样由 Rust 工具完成：

```sh
server/target/debug/trading-admin backup --data-dir var --output backups/run-1
server/target/debug/trading-admin restore --input backups/run-1 --data-dir var-restored
TRADING_ROOT="$PWD" TRADING_DATA_DIR="$PWD/var-restored" TRADING_BIND=127.0.0.1:8472 server/target/debug/trading-service
```

备份包含一致的 SQLite 快照、SHA256 清单和当前实例令牌，目录权限为 0700、文件为 0600；外部行情/券商凭据不在备份内。恢复拒绝覆盖非空目录，并验证校验值和数据库完整性。

示例使用独立8471端口，避免占用本机已有8787服务；如8471占用可改8797。Rust默认端口仍是8787，可用 `TRADING_BIND` 覆盖。`.env.example` 不会自动加载；将需要的值显式export或用宿主的环境管理工具注入。Node默认从PATH发现，只有需要时设置 `TRADING_NODE`。配置见 [.env.example](.env.example)，协议/权限/SDK/插件见 [API说明](docs/api.md)，执行合同与选型见 [架构说明](docs/architecture.md)。开发时使用 `TRADING_URL=http://127.0.0.1:8471 npm run dev`，`/api` 代理读取该变量（默认8787）；Rust正式路径直接托管 `dist`。

提供 Dockerfile 与 `compose.yaml`：`TRADING_PORT=8471 docker compose up --build`（默认发布8787）。容器以 UID 10001 运行，根文件系统只读、丢弃全部宿主 capabilities，只将 `/app/var` 和临时目录设为可写。Pine 的 bubblewrap 沙箱需要用户、网络和 PID namespaces；Compose 为嵌套沙箱声明 seccomp 和 systempaths 配置。容器构建、认证、React 静态服务和原生 Pine 成交已实际通过，记录见 [容器运行验收](docs/acceptance/docker-runtime.json)。该记录包含测试镜像哈希，不代表后续修改已自动验收。

Ubuntu 开启非特权用户命名空间限制时，先为本项目加载独立 AppArmor profile，再选择它启动：

```sh
sudo apparmor_parser -r deploy/apparmor/trading-dashboard
TRADING_APPARMOR_PROFILE=trading-dashboard TRADING_PORT=8471 docker compose up --build
```

这份 profile 仅用于显式选择它的容器，允许容器创建子用户命名空间；不修改全局 sysctl。Docker 的 `systempaths:unconfined` 用于让内部 PID namespace 挂载自己的 `/proc`，会放开容器默认的系统路径遮蔽，因此保留非 root 用户、只读根目录和空 capabilities，且不挂载宿主目录或 Docker socket。相关机制见 [Ubuntu 用户命名空间说明](https://documentation.ubuntu.com/release-notes/24.04/) 和 [Docker 运行参数](https://docs.docker.com/reference/cli/docker/container/run)。

Alpaca适配器仅使用Paper端点，可在宿主配置专用 `ALPACA_API_KEY` / `ALPACA_API_SECRET`。当前没有配置，因此 Alpaca 行情、账户和下单联网验收未执行；本地闭环无需这些密钥。Pine 事件 Host 已有独立的成交反馈 API，但仍需券商适配器传回实际成交，不能将本地回测成交当作券商成交。

恢复到独立数据目录后启动会自动应用迁移。服务数据目录有单实例锁，另一端口也不能重复占用。重启后queued任务续跑，running任务记为interrupted且保留错误，明确重试而非假成功。

开源许可边界见 [许可说明](docs/licenses.md)：新增服务等有AGPL许可，原前端授权仍需原作者确认，尚不能宣称整仓已完成开源发行授权。

## 本地运行

使用 Node.js 22.12 或更新版本。在本项目目录执行：

```sh
corepack pnpm install --frozen-lockfile --ignore-scripts --ignore-workspace
npm run dev -- --host 127.0.0.1
```

开发服务器默认也是上述服务工作台，需要同时启动Rust服务。若只体验旧前端，明确选择 Offline UI demo 后，在 Pine 编辑器粘贴脚本，选择 Add to chart / Update on chart 或 Backtest；仅检查脚本可用文件菜单中的 Check script。输入参数单独保存，不修改源码。策略报告使用脚本声明的本金、数量、手续费和滑点。Replay backtest 在 Paper Account 的 Strategies 页显示独立的历史权益和多空数量。

## CLI 运行公开策略

```sh
node scripts/pine.cjs run \
  tests/fixtures/pine-public/analyzer-anvil-percent-costs-01.pine \
  --data examples/pine/synthetic-spy.json --backtest
```

示例数据是确定性的合成序列，不是 SPY 历史行情。CLI 输出 JSON；成功退出码 0，执行失败 1，命令或文件参数错误 2。`Infinity` 等非有限数在 JSON 中以字符串表示。可加 `--inputs params.json`，文件使用变量名作为键，例如 `{"fastLength": 10, "slowLength": 30}`。

输入可以是 OHLCV 数组，或包含 `symbol`、`timeframe`、`metadata`、`bars`、`datasets` 的对象。`time` 和可选 `closeTime` 使用 Unix 秒；OHLCV 必须有限且时间严格递增。`datasets` 提供 `request.security` 等调用所需的其他标的或周期，每项含 `symbol`、`timeframe`、`bars` 及可选 `metadata`。缺失标的和低周期数据直接报错。真实美股数据应提供交易所时区、复权方式和会话对齐的各周期数据；通用 UTC 聚合仅用于明确允许这种聚合的数据。月线须提供每根 K 线的 `closeTime`。

## 验证

```sh
npm test
npm run typecheck
npm run build
npm run test:pine-public
```

`npm test` 验证确定的数值、成交与图形输出；公开语料测试逐个运行 312 个未修改脚本。完整结果保存至 [公开脚本执行报告](plans/research/pine-public-execution.json)。单个案例可用 `npm run test:pine-public -- 文件名片段` 复跑。任何失败都保留在报告中并返回非零退出码。

最新固定语料执行了 312 个公开脚本：首次批量 311 个通过，1 个触发 5 秒上限，在相同源码、数据和适配器哈希下单独复跑通过。汇总中 225 个产生已平仓交易，1 个有绘图样式降级提示；原始批次与复跑记录均保留在 [当前公开脚本报告](docs/acceptance/pine-public-current.json)。服务、持续模拟、MCP、插件、实时 Host 和券商离线故障的各自证据见 [验收索引](docs/acceptance/README.md)；每份报告只证明其记录的版本和测试范围。详细 Pine 覆盖与未完成项见 [Pine 兼容实现与验证](plans/pine-compatibility-review-2026-10-13.zh.md)。

公开测试测量的是指定数据下的执行覆盖率。TradingView 等价性需要使用相同源码、参数、行情、时区和撮合设置逐项对照成交与数值；执行成功率不能当作 TradingView 兼容率。

## 当前边界

- Pine 编译器和策略模拟器由 PineTS 提供。应用直接导入其原生成交、权益与未平仓仓位，避免第二次撮合。不会强制在样本最后一根平仓。
- 针对 PineTS 0.11.1 的 UDT 方法命名参数错误，`src/pine/compat.ts` 提供了限定于完整基础类型签名的绑定补丁，保留序列历史。补丁有独立断言；升级引擎时需重跑语料并评估移除。
- 支持本地数据和多标的请求；无法取得的数据不会被替换成图表行情。库 `import` 使用本地版本注册表与依赖哈希锁，支持已测试的函数、类型、枚举、方法和递归依赖；缺失库、循环依赖、未验证的重载和歧义冲突返回明确错误。不会自动取得 TradingView 私有或受保护库源码。
- 绘图接入折线、柱状、面积、基础形状、线、框、标签、表格、填色和蜡烛；复杂样式、对象自动缩放、文字排版及重叠顺序尚未达到 TradingView 像素一致。PineTS 的多次背景／K 线颜色调用可能合并，应用会提示。
- 浏览器 Worker 可取消并有 15 秒上限；CLI 独立 Worker 有 30 秒和 256 MiB V8 堆上限；策略回测最多 20,000 根。这些是资源控制，不能充当服务器执行不可信源码的完整安全隔离。
- 服务器的持续收盘模拟与实时 Pine 事件 Host 是不同执行模式，不能混用账本。前者重建并严格核对历史前缀，后者用持久事件恢复运行状态并接收实际模拟/外部成交。收盘模式边界见 [持续合同](docs/pine-continuous-contract.md)，事件 Host 参数见 [API 说明](docs/api.md)。默认手动模拟账户也由 Rust 持久化；只有明确进入旧离线 demo 才使用浏览器演示账户。

## 来源和许可

PineTS 使用 AGPL-3.0-only；分发和网络服务应按其许可证提供相应源码。公开 Pine 测试语料来自 [pineforge-corpus](https://github.com/pineforge-4pass/pineforge-corpus)，使用 Apache-2.0。其源码、固定提交链接、SHA-256、LICENSE 和 NOTICE 保存在 [测试目录](tests/fixtures/pine-public)。语料导入只包含 Pine 源码，不包含代码生成器或 TradingView 数据导出。

本次接入没有为原前端重新指定许可证；项目正式开源发行前仍需确认原作者对前端代码的授权，并完成完整依赖的许可证清单。

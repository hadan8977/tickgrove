# 数据与存储审计 · 2026-10-14

当前项目能用真实公开行情完成个人自托管看盘、原生回测、部分持续模拟；它不是已经完成的全市场专业行情终端。真实数据来自 Coinbase、Yahoo Finance，Alpaca 是需要专用账户权限且仍有代码缺口的适配路径。服务和数据持久化由 Rust 实现，界面由 React 实现，Pine 使用受控 Node/PineTS 进程；Python 只用于验收和离线日历生成。

本次仅审阅源码、现有验收、运行实例的文件路径和官方资料；没有改服务或界面、没有停止实例、没有读取或打印令牌内容。以下状态分别指「公开网络实测」「适配/离线测试」「待修或待授权」，不能互相替代。

## 用户可理解的数据矩阵

| 场景 | 现在实际来源与方式 | 可用性与限制 | 证据/状态 |
|---|---|---|---|
| 美股/ETF历史K线 | Yahoo chart REST，动态搜索标的，不是几只股票的白名单 | 美国市场研究用途；当前支持纽约交易时区。分钟历史范围受源限制，不能保证任意多年分钟数据。会保存来源与快照；不补造缺失价格 | SPY、VOO、MSFT等真实历史与ETF回测已实测 |
| 美股/ETF报价更新 | Yahoo公共pricing WebSocket；可选60秒报价轮询 | 确实收到真实推送，但不承诺交易所级低延迟、全市场完整逐笔或NBBO。未知/过期报价标明质量；Yahoo不作为本地模拟成交源 | SPY公开WS已实测；轮询仅辅助，不冒充tick |
| 盘前/盘后看盘 | Yahoo历史 `includePrePost=true` + 当前报价形成暂态K线 | 普通交易日纽约04:00–09:30、09:30–16:00、16:00–20:00；半日按日历缩短。暂态quote OHLC没有成交量，volume保持未知，等待正式历史闭柱核对 | regular/extended历史与时段测试已有证据；不等于夜盘 |
| 美股正式实时IEX | Alpaca `iex` | 需要自己的账户/密钥；IEX只是一家交易所，不等于全美股合并市场。没有专用凭据，本项目未完成真实联网验收 | 规范化与错误处理适配/离线测试 |
| 美股正式实时全市场SIP | Alpaca `sip` | 需要合适行情订阅与权限。当前不能承诺无需配置即可获得实时SIP | 外部权限未提供；未联网验收 |
| 美股20:00–04:00夜盘 | Alpaca `boats` / `overnight` | 两者权限、指示性报价与延迟成交不同；还存在端点与历史feed代码缺口，见下文。不能叫已完成 | 待修 + 待专用权限/实测 |
| 通用加密现货历史/实时 | Coinbase Exchange动态产品目录，REST历史 + ticker/matches/heartbeat WS | 仅Coinbase列出的交易对与该交易所成交，不是全球所有币/所有交易所汇总。支持非BTC/ETH标的及不同报价币；本地模拟账户当前仅USD | BTC、ETH、SOL、LTC目录/历史/公开WS与BTC未来真实闭柱开平仓已实测 |
| 深度/成交明细 | Coinbase REST book level=2快照；matches真实成交事件 | 深度是按需REST快照，不是完整持续实时L2订单簿；逐笔是已收到的真实事件，不能补造断线期间逐笔 | 当前合同明确区分 |

Yahoo的官方说明将数据定位为信息参考，并明确禁止再分发；公共端点可访问不构成正式、稳定、可再授权的数据API产品。[Yahoo数据来源与使用限制](https://help.yahoo.com/kb/SLN2310.html)

Alpaca当前官方计划区分Basic的实时IEX与更广覆盖的付费SIP，并区分符号数、历史请求额度与最近数据权限；应在配置页显示用户账户实际权限，不能用通用「实时」开关代替。[Alpaca Market Data计划](https://docs.alpaca.markets/us/docs/about-market-data-api)、[Market Data FAQ](https://docs.alpaca.markets/us/docs/market-data-faq)

## 时段与Alpaca尚未落实的具体问题

当前标准时段使用 `America/New_York`，内置XNYS 1990–2035版本化日历，含假日、夏令时、提前收市；可通过 `TRADING_CALENDAR_FILE` 替换/扩展。未知范围报错，未来临时休市需更新。该日历不是全球交易所通用日历，也不能保证每个交易所、每个feed的全部特殊时段。[NYSE官方时段](https://www.nyse.com/trade/trading-information)、[提前收市与17:00晚盘结束说明](https://s2.q4cdn.com/154085107/files/doc_news/NYSE-Group-Announces-2024-2025-and-2026-Holiday-and-Early-Closings-Calendar-2023.pdf)

官方夜盘通常20:00–次日04:00 ET，归属次日交易日，遵循NYSE假日日历；它与盘后16:00–20:00不同。官方目前说明，免费的 `overnight` 包含实时指示性报价、延迟成交；夜盘历史查询使用 `boats`，无相应实时权限时结束时间至少落后15分钟，不能用 `overnight` 查询历史。[Alpaca 24/5与feed说明](https://docs.alpaca.markets/us/docs/245-trading-for-trading-api)

只读审计发现以下实现缺口，不能仅以「还没填密钥」解释：

- `server/src/market/stream.rs` 当前统一拼接 `wss://stream.data.alpaca.markets/v2/{feed}`；官方要求IEX/SIP为 `v2`，BOATS/overnight为 **`v1beta1`**。夜盘路径需修正并重新验收。
- `history.rs` 将用户选择的 `overnight` 原样传给历史bars端点；需按官方支持矩阵选择历史 `boats`、记录真实来源并校验15分钟权限，不能悄悄把指示性报价当实际成交。
- 当前每个symbol/timeframe开一条连接。官方说明许多个人订阅每endpoint仅允许一条连接，第二条会返回406；应先实现每账户/feed连接复用，再承诺通用多标的Alpaca看盘。[官方WS端点](https://docs.alpaca.markets/us/docs/real-time-stock-pricing-data)、[连接与认证限制](https://docs.alpaca.markets/us/docs/streaming-market-data)
- 历史夜盘周/月聚合仍需专门核对：`period::expected_base_times`当前按regular/extended生成期望槽位，没有独立overnight分支；不能将未验证聚合标成完整。
- 适配当前处理q/t/b/u；官方还会发送成交修正、取消等类型，尚未形成完整修正账本合同。feed级延迟/指示性属性也应进入质量与执行权限判断。
- Alpaca当前UI/API会拒绝显式extended session；regular/overnight配置不意味着已覆盖所有股票扩展时段交易。

## 真实端点与数据口径

| 提供方 | 源码实际访问端点 | 口径 |
|---|---|---|
| Coinbase目录/身份 | `https://api.exchange.coinbase.com/products`、`/products/{symbol}` | 动态交易对、venue、报价币、价格/数量步长 |
| Coinbase历史/报价/深度 | `/products/{symbol}/candles`、`/ticker`、`/book?level=2` | Coinbase Exchange现货；历史每页按≤299槽分页，4H由1H、1W由1D聚合 |
| Coinbase持续源 | `wss://ws-feed.exchange.coinbase.com` | ticker、matches、heartbeat，不是每秒历史拉取 |
| Yahoo搜索/历史 | `https://query1.finance.yahoo.com/v1/finance/search`、`/v8/finance/chart/{symbol}` | 非正式公共端点；历史raw或按adjclose/close比例调整OHLC，必须保留调整口径，不能称标准化总收益指数 |
| Yahoo持续源/辅助报价 | `wss://streamer.finance.yahoo.com/?version=2`；chart `range=1d` | 公共protobuf报价推送；60秒REST报价辅助；前收盘使用短范围真实metadata，不能用长历史首日之前的收盘冒充 |
| Alpaca资产/历史 | `https://paper-api.alpaca.markets/v2/assets`、`/assets/{symbol}`；`https://data.alpaca.markets/v2/stocks/{symbol}/bars` | 独立专用密钥；feed及raw/split/dividend/all调整；bars page_token分页 |
| Alpaca持续源 | 当前代码 `wss://stream.data.alpaca.markets/v2/{feed}` | IEX/SIP路径正确；夜盘版本错误，见上文 |

所有不可变历史快照包含symbol身份、venue、currency、timeframe、timezone、session、adjustment、provider/feed、接收/事件时间、请求范围与gaps等来源信息。范围和来源不相同的快照不能混当同一价格序列。当前缺数据会明确返回诊断；`allowGaps`只许可看图，不许可在策略部署时默默当完整数据。

Coinbase官方指出，无成交区间可能不发布历史K线；每请求最多300根，建议实时信息使用WebSocket。[官方candles合同](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles)

## 页面刷新路径

当前链路为数据源REST历史/WS实时 → Rust接收、规范化与K线聚合、SQLite事件与快照 → React读取增量事件并重绘。源端WebSocket是真实推送，但浏览器目前没有与Rust建立WebSocket：`src/data/feed.ts`每700ms尝试一次`market.events`增量轮询，每批最多4个订阅并行，上轮未结束会跳过，所以700ms不是端到端延迟保证。订阅越多，HTTP与序列化成本越明显；断线缺失不会用假tick补齐。

成熟演进建议先复用每提供方/账户/feed的上游连接，再把浏览器多订阅请求合并为单个带cursor的批量事件流，必要时采用SSE/WebSocket分发；保留重连游标、过期诊断和快照恢复，不能只把轮询改成推送而丢失可恢复性。UI显示的Live/Delayed/Stale取决于源质量与报价时间，不能以浏览器定时器在运行作为实时证明。

## 加密聚合、确认与断线恢复

每个订阅从真实match事件按时间桶形成K线，用trade ID去重，heartbeat检查缺失，按交易对真实价格/数量步长规范化，避免浮点累加误差伪装成修订。初次订阅、断线或漏成交会标incomplete；不制造空桶价格。断连自动退避重连，恢复持久已见事件并用REST核对最近闭柱。REST常规核对每30秒，缺口补查有异步延后任务。

Coinbase最新REST闭柱可能仍修订，因此历史快照默认只接受落后当前时间120秒的边界（`TRADING_COINBASE_CONFIRMATION_SECONDS`可60–600秒）。这是本项目确认策略，不是Coinbase保证最终性的承诺；实时WS报价与形成中K线不因此延迟120秒。形成中/未确认数据与可用于策略的确认闭柱必须分别显示。

持续闭柱策略只接纳完整的追加行情，提交后若历史真实改变会冻结而不是重写账本。事件宿主可恢复已写入journal的tick与成交；**从未收到的断线tick不能从OHLC恢复**，仍不是无损专业tick档案。[Coinbase频道与丢失消息处理说明](https://docs.cdp.coinbase.com/exchange/websocket-feed/channels)

已有真实证据：`docs/acceptance/paper-public-stream.json`记录未来BTC行情65→70根与0.0001BTC原生开平仓；`pine-host-browser.json`记录实际tick/varip/图表。索引优化后的约20秒窗口为20/20 fresh、10个不同报价时间，status HTTP中位22.93ms，报价年龄中位约1.93秒、最大8.41秒；这是短窗实测，不能扩展为长期SLA。过去确实出现过最高约123秒消费积压，已保留诊断而非删去失败：`market-latency-diagnostic.json`、`market-status-index.json`、`market-latency-current.json`。

## 数据许可与部署方式

开源代码不授予第三方行情的复制、公开展示或转售权。Yahoo限制再分发；Coinbase于2026-08-07更新的条款限制个人/实体内部研究使用及向外部分发（包括派生图表），额外用途需相应书面许可；Alpaca与交易所订阅协议也不因有API key而自动授予终端再分发权。个人自托管与对外公开多用户产品，应分开选择数据合同。[Yahoo限制](https://help.yahoo.com/kb/SLN2310.html)、[Coinbase Market Data Terms](https://www.coinbase.com/legal/market_data)、[Alpaca Terms](https://s3.amazonaws.com/files.alpaca.markets/disclosures/library/TermsAndConditions.pdf)

当前Paseo预览与测试实例按数据目录隔离：

| 入口 | 数据目录 | 实际意义 |
|---|---|---|
| 当前预览 `127.0.0.1:17915` | `/root/finance/tradingdashboard/var/paseo-preview` | 已只读核对该进程打开的SQLite/WAL/SHM及锁文件；不是原始演示localStorage数据库 |
| 根代理独立验收 `127.0.0.1:18879` | `var/ui-real-data-review` | 独立DB/令牌，不与预览共用 |
| 普通源码启动 | `TRADING_DATA_DIR`，默认项目`var` | 默认端口8787；本机端口占用时需显式选择空闲端口 |
| Docker Compose | named volume `trading-data`→`/app/var` | 数据与镜像分开持久化；容器重建不等于删除volume |

`paseo-preview.cjs`只负责启动Rust，端口由 `PASEO_PORT`选择（脚本默认8471，当前保存值17915）；环境显式只传PATH与本项目运行路径，未借用其他项目的Alpaca凭据。`paseo-share.cjs`仅给现有同实例提供可选隧道，不启动第二套数据服务。当前表结构是单工作台/共享本地模拟账户，Bearer scopes不是完整多租户用户隔离。

Docker**不需要另装SQLite服务，也不需要单独Postgres容器**：SQLite嵌入Rust，DB文件就在持久卷。应保持一实例使用一个本地数据目录/卷，不让多个容器或跨主机NFS并发共享同一SQLite文件。SQLite WAL依赖同主机共享内存与文件锁，不支持这种横向扩容用法。[SQLite WAL](https://www.sqlite.org/wal.html)

已有容器验收证明当时镜像非root UID10001、只读根文件系统、cap-drop ALL、Node与bwrap真实Pine执行，无Python运行依赖。主机需支持非特权user namespace；Ubuntu实际采用项目独立AppArmor配置。当前Compose默认AppArmor unconfined只是兼容默认，成熟部署应明确选择受验收profile；现有安全选项不能直接称全方位容器硬化。容器报告对应04:13构建，不意味着此后每次源码修改都已重新构建镜像：`docs/acceptance/docker-runtime.json`。

## SQLite到底保存什么

Rust使用一个SQLite连接、WAL模式、外键与21版迁移；同数据目录先取 `instance.lock`，第二实例拒绝。生产权威状态在服务器DB，浏览器内存缓存/令牌和演示模式不替代它。

| 数据组 | 表 | 保存内容 |
|---|---|---|
| 策略与复现 | `strategy_versions`、`pine_libraries`、`snapshots` | 不可变源码版本、库锁、完整JSON OHLCV/多资产快照、hash/provenance |
| 任务与命令 | `jobs`、`events`、`commands` | manifest、排队/运行/取消/终态、结果JSON、错误、幂等响应 |
| 行情 | `market_subscriptions`、`market_events`、`market_bars`、`market_trade_ids`、`market_source_bars` | 持续意图、源事件/质量/游标、闭柱/形成柱/修订、去重ID、Alpaca组成分钟线 |
| 原生闭柱持续策略 | `paper_sessions`、`paper_events`、`paper_bindings`、`paper_market_pending` | 已提交与pending分离、输入、运行结果引用、绑定来源、待拼接真实闭柱 |
| Pine事件宿主 | `pine_host_sessions`、`pine_host_events`、`pine_host_orders`、`pine_host_intents` | 模式、hash、计算结果、真实事件journal、订单映射、持久outbox |
| 工作台 | `workspaces` | 布局、自选列表、绘图等完整UI文档及乐观revision |
| 本地模拟账户 | `local_account`、`local_positions`、`local_orders`、`local_fills`、`local_order_events` | Rust报价撮合账本、费用、订单状态、来源feed/cursor；不二次撮合Pine原生回测 |
| 提醒 | `alerts`、`alert_history`、`pine_alert_history` | 价格规则、触发历史、策略提醒 |
| 迁移 | `_sqlx_migrations` | 已应用迁移与校验记录 |
| 插件与外部适配 | `plugin_state`、`broker_orders`、`broker_events` | 插件启用权限声明、Alpaca订单请求/幂等/核对状态；不是密钥库 |

数据目录主要文件为 `trading.sqlite`、运行中的 `trading.sqlite-wal`/`-shm`、`instance.lock`、`auth-token`；预览另有port、seed/检查证据与share日志。源码、依赖、扩展代码和日历通常来自项目/镜像，不在DB。令牌是0600权限文件，不能因此称数据库内容已加密。Alpaca密钥由外部环境配置，未存入快照/备份。

已实现Rust `trading-admin`在线一致性备份（VACUUM INTO）、SHA256 manifest、令牌权限与空目录恢复验证；这比运行时只复制主sqlite文件安全。当前备份包括DB与存在的auth-token，**不自动包括**依赖/策略执行器源码、外置日历、扩展文件、外部tokens配置和凭据；成熟恢复需要同时保存部署版本与这些配置。恢复到新空目录，不覆盖运行实例。证据：`docs/acceptance/backup-restore.json`。

## 缓存、并发与规模边界

- 浏览器facade合并正在进行的历史请求Promise，并缓存行情序列、订阅与深度，HTTP并发预算3；这是当前页面缓存，不是服务器全局历史缓存。服务器每次持久history请求保存新的完整快照，即使范围重复，也未做通用TTL缓存/内容去重。
- 历史任务并发预算4、每次HTTP超时20秒、单快照最多20,000个bucket；Coinbase分页间隔120ms，Alpaca单页10,000条、最多100页；Yahoo当前一次请求，不具备任意长分钟历史自动分段能力。
- Coinbase官方REST上限按IP 10请求/秒、突发15；当前信号量/每任务120ms间隔**不是全局token bucket**，目录、quote、depth等不全受history预算约束，多个任务仍可429。Yahoo没有在项目中获得正式额度/SLA；Alpaca按用户计划额度。[Coinbase限流](https://docs.cdp.coinbase.com/exchange/rest-api/rate-limits)
- `TRADING_MAX_SUBSCRIPTIONS`默认32，可配1–256；它限制symbol/timeframe订阅数量，不是经过压测的32/256路容量保证，多个周期会重复源连接与事件。
- 行情events全局默认100,000条（可10,000–1,000,000），约每1000 cursor清理；每订阅闭柱默认10,000（可1000–100,000），trade IDs默认100,000（可10,000–1,000,000），会周期清理而非精确逐条上限。Alpaca组成分钟线保留约35天。游标过期明确暴露，不静默跳过。
- 策略版本、历史快照、任务/结果、提醒历史、host journal及命令幂等记录没有通用自动归档/删除策略；查询LIMIT不等于落盘保留上限。闭柱逐次运行还会保存增长的完整快照与结果，长期空间增长需实测，不能称磁盘永远有界。
- 原生worker并发1；Pine事件宿主默认2（可1–8），宿主进程访问由全局mutex串行；每事件10秒、heap256MB，有journal/bar重放预算。它适合当前单机资源合同，不是多租户高吞吐保证。
- 单SQLite连接让事务清晰，也让热点读查询与逐trade多次写排队。两条quote索引已消除已测status热点，但没有完成全市场burst压测或持续延迟SLA验收。

## 成熟演进建议

**当前个人本机或一台自托管服务器，保留SQLite最合适。** 不需要为了“成熟”先引入Kafka/Kubernetes或单独数据库运维。先修正式feed合同与连接复用，建立每provider限流/请求合并、最新报价缓存与有界事件写入队列（原始成交不能无声丢弃）、归档策略、运行指标与备份恢复演练。选择正式有许可的股票数据源，Yahoo保留为明确个人研究fallback。

**需要多用户独立账户、多个应用实例、持续写入竞争或高可用时，再转Postgres。** 触发标准应是实际写入队列/事务延迟和服务可靠性目标无法满足，不是任意“有多少股票”或“达到几GB”阈值。先抽取存储接口，保留不可变版本、幂等、CAS、pending→committed与事件游标合同，再迁移事务状态。SQLite官方也将多服务器、写密集和多并发writer列为客户/服务器数据库更适合的情况。[SQLite选型说明](https://www.sqlite.org/whentouse.html)

**大历史、原始tick档案和大报告单独演进为Parquet/对象存储。** 数据按provider/venue/feed/symbol/session/adjustment/日期分区；DB只保存权限、manifest、内容hash和对象引用。先可用本地文件/备份目录，确需远程持久化再选择S3兼容存储。对象先写完整并校验后再提交DB引用，恢复时校验hash；不能因分层存储丢失复现来源或把未接收tick补成完整。

成熟对外部署还需要已授权数据分发、多用户身份/账户隔离、HTTPS与明确的浏览器令牌策略、升级回滚、容量告警和最新镜像验收。这些是演进要求，当前文档与短窗测试不代表已经完成。

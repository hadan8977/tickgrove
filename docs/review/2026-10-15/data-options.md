# Tickgrove 数据方案比较

2026-10-15 · 美元公开价格，不含税、主机、存储、流量或未明确包含的授权费用。**尚未采购，也尚未选定交付模式。** 本文更新初始数据审查里的 BYOK 工作假设；架构缺陷与修复要求仍然有效。

建议同时评估“开源软件如何交付”和“谁提供行情”，它们可以独立选择。自托管不一定要求用户自己采购全部数据；项目提供共享数据也不等于必须关闭源码。

## 对标正式产品应该对标什么

TradingView 也采用分层行情：默认美股实时来源为 Cboe，主要交易所数据另行订阅；软件付费计划并不自动包含这些交易所费用。因此，可以做成熟的基础看盘体验，再提供更完整数据接入，但必须说明实际来源，不能把不同 feed 称为同一价格或同一成交量。[默认数据说明](https://www.tradingview.com/support/solutions/43000473924-is-us-stock-market-data-free-by-default/)、[额外行情订阅](https://www.tradingview.com/support/solutions/43000471705-how-to-purchase-additional-market-data/)

正式产品的要求是：授权清楚、来源稳定、口径明确、接入简单、断线有恢复、历史与实时一致、可测的延迟与容量、失败能解释。不是仅把价格刷得更频繁。

## 四种可实现方案

| 方案 | 用户能得到什么 | 已核实的成本参照 | 开发与运维 | 评估 |
|---|---|---|---|---|
| A 免费体验 + 可选个人免费源 | 打开即用的回放教程；个人环境可接受支持的公开加密源、免费 IEX 或延迟股票源 | 纯回放可以没有实时订阅费；托管和回放素材权利仍有成本 | 回放闭环/重置/来源标签；公开实时源另核对展示权 | 最适合低成本体验入口，不能满足全部正式实时/夜盘目标 |
| B 用户自备正式行情 | 自托管后连接个人/组织获授权源；股票、ETF、夜盘、加密按权限使用 | Alpaca Plus **$99/月**；Massive Advanced **$199/月**，后者本次未确认夜盘 | 连接向导、密钥保存在服务器、权限探测；项目无需给每位用户支付数据费 | 最适合开源基座和个人正式研究；首次配置和用户预算是门槛 |
| C 项目提供共享基础实时看盘 | 用户打开即看到统一实时行情，不必先办理数据商账号 | Databento US Equities Standard / EQUS.MINI **$199/月服务费起**，另计基础设施及未包含历史/用途 | Rust 数据网关、访问控制、限流缓存、监控、明确分发合同 | 值得评估的低成本共享路线；Mini 是衍生复合行情，不能称全市场 SIP，夜盘另评估 |
| D 项目提供完整共享实时市场数据 | 项目负责合并市场逐笔/报价以及单独约定的夜盘等产品 | 以 Massive 明码作量级参考：Business **$2,499/月** + Full Market **$1,999/月** = **$4,498/月平台及扩展费**；交易所、用户/用途、税与运维另计，夜盘未包含在本次确认范围 | 用户权限/报告、商业协议、非展示计算与数据导出范围、可靠数据服务 | 最顺滑但责任和固定费用最高；应有明确用户规模和资金计划后采用 |

这些是接入后的能力，不是 Tickgrove 当前已完成的状态。数据采购不会自动修复现有夜盘、连接复用或执行语义问题。

## 数据商如何选

### Alpaca

Basic 免费，股票实时仅 IEX；Plus $99/月提供更完整的美股/ETF 实时覆盖。官方夜盘说明将 Plus 对应 BOATS，免费 overnight 的报价/成交质量不同；历史夜盘也要按正确 feed 请求。它与当前实现最接近，适合首先做完整的个人数据路线。账户地区、专业身份、用途和实际权限仍以账户审核/合同为准。[数据计划](https://docs.alpaca.markets/us/docs/about-market-data-api)、[夜盘说明](https://docs.alpaca.markets/us/docs/245-trading-for-trading-api)

这个 $99 是个人 Trading API 计划，不能把一把 key 公开复用成多人数据服务。Broker 合作伙伴有单独方案，不能把其 IEX/延迟 SIP 套餐行当成实时 SIP 再分发价格。共享服务需匹配合同/报价。

### Massive

个人 Advanced 按月 $199，年付 $1,920（折 $160/月，但需预付整年），用于实时与长历史研究。公开资料覆盖 04:00–20:00 ET；本轮没有验证 BOATS 夜盘产品。个人计划标注 individual/non-professional，不能当企业共享授权。[股票计划](https://massive.com/stocks)

Business 基础计划是实时衍生 FMV + 盘后完整历史，**基础价格不代表盘中全市场逐笔**。当前月付 $2,499；页面还列承诺期月付 $1,999、年付 $19,188（折 $1,599/月）。Full Market 实时扩展另列 $1,999/月，并提示额外交易所费用。因此 $4,498 只是按无承诺月付基础价相加的参照，不是全包商务报价；不混算年度折扣和未知扩展折扣。[Business 计划与扩展](https://massive.com/business-stocks)

展示授权与转售 API/文件/机器可读行情不是同一用途，Tickgrove 的 CLI/MCP/导出需要明确匹配合同。[Business 条款](https://massive.com/legal/businesses-terms-of-service)

### Databento

本轮直接读取官方 US Equities 报价接口：Standard `unit_price=19900`，定价组件按美分换算，为 **$199/月、一个月承诺期**，允许 live `EQUS.MINI`。Plus 为 $1,500/月、Unlimited 为 $4,000/月，后两者带 12 个月承诺；不是本项目初期必须购买的方案。以所选产品当前下单条件为准，不能拿定价页默认 CME 数字代替股票报价。[官方报价接口](https://databento.com/api/v0/dataset/service_offerings/us-equities)、[定价页](https://databento.com/pricing)、[本轮原始报价](evidence/databento-offerings.json)

EQUS.MINI 是多个 venue 的衍生 BBO/成交组合，官方说明允许符合其条件的商业展示及分发，无额外交易所/逐用户许可费。它是共享基础看盘的候选；不是 SIP 或完整市场成交量。其他 dataset、夜盘、超出包含范围的历史，以及转售原始数据 API 的用途要分别确认，不能把 Mini 的许可扩大到整个 Databento 产品线。[Mini 官方说明](https://databento.com/blog/databento-us-equities-mini-now-available)

有官方 Rust SDK，适合当前技术栈；接入仍需实现 Tickgrove 的能力、恢复、归档与修订合同，而非只连上行情就完成。

### Coinbase 与 Kraken

两者的公共接口适合评估个人加密行情接入，提供各自交易所价格；不能自动视为全球汇总。Coinbase 已有适配，优先补齐缺成交恢复和需要时的持续 L2。Kraken 可作独立第二 venue，但普通 OHLC 接口仅返回最近 720 条，不满足任意深历史研究。[Coinbase 频道](https://docs.cdp.coinbase.com/exchange/websocket-feed/channels)、[Kraken OHLC](https://docs.kraken.com/api-reference/market-data/get-ohlc-data)

公共接口可访问并不等于可给全站用户展示。Coinbase 数据条款明确涉及外部分发/派生图表限制；本轮未取得 Coinbase/Kraken 共享数据商务报价，也没有确认 Kraken 可无条件商用再分发。因此不能把加密公共 demo 的数据费与授权直接写成零。[Coinbase 数据条款](https://www.coinbase.com/legal/market_data)、[Kraken 法律入口](https://www.kraken.com/legal)

## 对 Tickgrove 的建议

**推荐讨论的组合是 A + B，并让 C 可以后续接入；暂不默认承担 D 的成本。** 这是方案建议，等待用户选择，不是采购决定。

- 首次打开能在同一服务器引擎上完成示例闭环；回放标签与时间清楚，休市也能体验。
- 正式自托管有一个简洁的“连接数据”入口，用户可接自己的 Alpaca/Massive 等；数据质量和权限在配置后自动检测，不要求理解全部 feed 名称。
- 如果希望网站默认就有实时美股，先评估一个 EQUS.MINI 共享试点，设预算、配额和使用边界；需要 SIP、夜盘或严格可复现研究的用户仍可以选择自己的源。
- 若未来多数用户需要开箱即用的 SIP + 夜盘，再按实际活跃人数、非展示计算、导出量和服务目标评估共享商业合同，而不是现在就假定所有用户都由项目补贴。

无论选择哪一种，先完成统一能力与事件接口。图表、提醒、策略和 CLI/MCP 不应各自猜来源；策略固定 provider/feed/session/adjustment，不能无提示拼接 Mini 实时、SIP 历史、Yahoo 报价和 BOATS 夜盘。

## 选择之前还需确认的事项

| 项目 | 影响 | 工程现在能否推进 |
|---|---|---|
| 是否由项目支付共享基础行情 | 采用 A/B 还是加入 C，月预算和在线服务责任 | 可以，适配合同和网关接口相同 |
| 全市场 SIP 是否必须默认提供 | 共享费用、用户身份/授权流程 | 可以，先把品质与权限建模好 |
| 夜盘只是看图还是还要策略/模拟 | 需要的报价/逐笔质量、交易时段和订单能力 | 可以先做 fixture，真实 feed 验收需要权限 |
| 所在地区/个人或机构身份 | 数据账户可开通性、个人价是否适用 | 不能从公开价替用户确认 |
| 公开 demo 是否允许机器可读导出 | API/MCP/下载的合同范围 | 可以先做回放或限制在已授权用途 |

数据费、基础设施和开发维护费应单列。没有额外采购 SQLite 服务的要求；本地主机可沿用现有硬件，云主机价格需在用户选择部署规模后再估，不在这里虚构“全包每月成本”。

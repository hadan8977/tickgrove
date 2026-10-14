# 交互审计 · 2026-10-14

审计对象是完整原工作台加服务端流程，不是删成一个新表单。按 `docs/features/checklist.json` 的96项逐组映射；清单的verified/partial/planned表示功能验收状态，不代表按钮是否好用。本次主要是源码路径审查，**未在公共预览下单、部署、改提醒、删数据或恢复工作区**；静态发现不冒充浏览器复现。根代理同时重构Shell、Library、PineEditor、MarketBadge、Popover、字体、ChartPanel，本报告不重复改这些模块。

监督方单独授权修复 `BacktestReport.EquityChart`：真实基准改用报告绑定的不可变快照，处理加载/空数据/时间对齐与卸载，不使用当前全局行情；继承body字体。5项实际函数fixture与TypeScript检查通过，证据 `docs/acceptance/backtest-benchmark-ui.json`。除此之外，本代理只新增审计文档/验证，不修改其它实现。监督方已在Automation界面加入dirty提示、保存版本与草稿区分；旧问题记录保留，不能把修复前结论套到新界面。

提交前复读确认根代理已修U03现金/分组shape、U04空价格回退、U05切标的清票据、U06仓位工具只做计算、U08部分错误/停止控制，并修改报告header/cards响应式。表中保留发现时触发条件，建议列区分代码已改与待回归；没有据此批量修改96项验收状态。

## 使用路径与层级

基础层只突出：选标的看图 → 管理自选 → 编译/运行脚本与参数 → 查看回测 → 本地模拟交易与订单 → 建价格提醒。运行对象要始终显示人能识别的策略名、标的、周期、日期、来源、状态；UUID/hash/manifest保留在可复制的详情，不充当名称。

进阶层保留：多资产组合、持续闭柱模拟、完整报告/订单历史、日期与数据口径、回放、库导入。开发/运维层保留：自定义JSON事件、tick/external BrokerHost、API/CLI/MCP、插件权限、不可变快照与版本、数据库备份诊断。这是整理入口与披露顺序，不是删除复杂功能。会影响交易对象、价格、费用、数据质量和账户归属的信息不能因“简化”被隐藏。

具体要区分：真实行情 ≠ 真实资金；本地模拟账户 ≠ 原生回测账户；历史回放 ≠ 后台持续运行；外部fill接口 ≠ 已连接券商；UI工具开关 ≠ 宿主插件授权。后台写操作被拒绝时，前端不能仍暗示成功。

## 功能组现状与建议

| 功能组 | 当前UI现状 | 最主要交互问题 | 基础/进阶安排 | 本轮风险 |
|---|---|---|---|---|
| Data · 15项 | MarketPanel、图表来源徽章、PortfolioData、导入入口 | 通用配置直接暴露provider/feed；换源保留无效symbol；分钟周期搭配默认一年范围；“支持”不等于凭据/许可/实现已就绪 | 基础默认源/范围与人类状态；高级时段、复权、组合；诊断才显示快照/源事件 | 范围/空态/标签可改；正式源权限与夜盘修复不可仅用UI宣告完成 |
| Workspace · 7项 | 原Dockview、预设、联动、服务端保存 | 小屏原桌面面板密度高；导入恢复直接覆盖当前状态；服务同步冲突/只读权限需稳定提示 | 基础布局预设/保存状态；高级面板和导入导出；运维连接权限 | 根代理当前所有权，记录上下文不交叉修改 |
| Charts · 10项 | 原图形、工具、对象、回放、比较 | 数据范围/图表快照/比较基准需要一致；默认可见操作与二级工具密度高 | 常用绘图/回放基础；对象细节/指标参数/比较进阶 | 图表模块根代理处理；不因精简回退Pine绘图 |
| Watchlists · 6项 | 管理/排序/拖拽/导入，自选报价、详情、深度、逐笔、两工具插件 | hover-only删除；长canonical标的；窄列精度；详情硬编码两位价；插件计算假设混同保护订单 | 基础自选与简明报价；详情深度/统计；工具单独命名 | 多为局部可改；金融语义不能只换皮肤 |
| Pine · 13项 | 编辑器/库/参数；PineHosts高级事件执行 | 假定用户理解不同执行合同；terminal宿主无法重新打开完整渲染；兼容性/运行模式需要诊断而不是泛化标签 | 编译/参数/回测基础；库进阶；tick/external开发层 | 既有真实验收保留；完整兼容缺口不能UI抹去 |
| StrategyBuilder · 8项 | 原条件树与Pine生成；另有Composer编辑器 | 340px代码预览按window而非panel展开；380px确认框；现金/组shape检查曾缺；删除无撤销；比例输入0–1 | 原条件树、组合各独立入口；Pine/JSON源码折叠 | 响应式/文字可改；Cash/Group需完整UI回归 |
| Backtest · 7项 | 两套结构化报告、任务进度、比较与导出 | 历史报告基准错读当前行情（已修）；点击交易不真正跳图；宽表/工具栏；失败/缺数据只在详情 | 基础摘要/曲线/交易与运行状态；进阶完整指标、比较、来源、导出 | 基准已限定修复；其余根代理可逐项改并验收 |
| Trading · 11项 | OrderTicket、ServerAccount、图上操作、ServicePaper/PineHosts | 空价格被默认为报价；切标的保留旧价；平仓结果缺反馈；shared/native账户混淆；持续任务控制分散 | 基础票据+账户；持续闭柱进阶；tick/external开发层 | 错价/止损假设优先；券商联网不能伪装完成 |
| Alerts · 4项 | 价格表单、列表、历史、Pine消息与站内通知 | 无提交锁；标的/周期只取打开时初值；已触发/删除仍显示Resume；缺源健康/结果定位 | 基础“当前图表价格提醒”；高级频率/到期；策略提醒单独说明 | 局部表单/状态反馈可改；扩展通知通道需能力实现 |
| Extensions · 7项 | Settings实际进入Interfaces；命令JSON、UI工具、宿主插件、库、权限 | 普通Settings默认开发控制台；两种插件权限混在一起；CSV导入成功无后续定位；复制缺失败反馈 | 普通设置在前；Workspace tools与Server extensions分开；API开发页后置 | 排布可改；不把前端registry假称真实服务器命令 |
| Operations · 8项 | 连接/能力/Automation/持久作业；CLI备份与Docker | DB/hash/UUID文案穿透正常路径；默认只读仍能点写按钮；原始错误缺下一步 | 基础连接与保存健康；运维诊断/备份/资源权限 | 标签与禁用理由可改；完整生产能力不随UI更新而完成 |

## 主要问题与最小处理

“可本轮”指可以在现有接口上做小改并验证，不是授权本代理修改其它模块。S1会错误理解运行/交易对象或结果；S2阻断工作流、结果不可找或状态误导；S3发现性/密度/无障碍问题。文件名是审阅入口，不承诺行号在并行改动后不变。

| 编号 | 等级 / 功能 | 审计发现时的路径或触发条件（修复见建议） | 最小建议 / 本轮判断 |
|---|---|---|---|
| U01 | S1 R03/C10 | BacktestReport旧EquityChart用getBars当前缓存，空bars直接[0].open；历史报告有崩溃/错基准条件 | **已限定修复**：manifest快照、状态、时间对齐、取消异步；浏览器还需根代理验收 |
| U02 | S1 R01/R06 | ServiceWorkbench旧源编辑/换kind后仍持旧version，可运行旧保存源 | **根代理已修dirty门禁与“Use latest backtest”**；检查新选择/输入与实际manifest一致 |
| U03 | S2 B04/B05 | AllocationEditor提供cash/group，但shape只认asset/weight/condition/filter，选后可视编辑消失 | **根代理已补cash/group shape分支，待界面回归**；合法递归与坏JSON都保留，不删菜单掩盖缺口 |
| U04 | S1 E02 | OrderTicket使用Number(price)||q.last：空/0限价或止损价会被替换成市价附近的值 | **根代理已去掉报价回退并禁用无有效非市价的提交，待回归**；保留就近校验，显式用最新价动作可后续做 |
| U05 | S1 E02/E11 | 票据跟随active chart，但price/qty/stopPrice保持旧state，切资产仍用旧订单参数 | **根代理已在切标的时清数量/限价/触发价，待回归**；对象/来源同屏核对仍保留 |
| U06 | S1 L06/E04 | PositionSizer展示stop @/max loss，Paper buy实际只提交market，没有止损单；数量Math.floor还忽略加密步长 | **根代理已改计算说明与Open order ticket，不再直接买**；仍未自动填票据数量，整数量假设/小数步长可后续改善 |
| U07 | S2 R04/C09 | BacktestReport Trades点击：有对应chart时什么都不做；无chart才toast“打开图来跳转” | 真正跳转到entry/exit范围，或移除交互暗示并说明；不能留下承诺但无动作的事件handler |
| U08 | S2 E08 | ServicePaper不渲染s.error、无Stop入口；poll catch吞错；stopped仍“ready for next event”；pending各种按钮不看pending_job_status | **根代理已加Stop/s.error与轮询错误，待回归**；尚有UUID名、stopped显示ready、pending不按状态区分等问题 |
| U09 | S2 E03/E05 | ServerAccount Flatten仅传provider/symbol，省略实际feed；act忽略返回rejected，positions页没有明确新平仓订单定位 | 不猜feed；展示已提交/等待报价/拒绝/已平仓及跳订单。涉及来源合同的部分需协调服务，不能只toast成功 |
| U10 | S2 D01/D02/D06 | MarketPanel换Coinbase仍保留SPY；默认一年date切1m常超20,000槽或源分钟历史限制 | provider示例/动态选择、按period建议范围、保留用户手改日期并做范围预检；错误给可选修复不伪造价格 |
| U11 | S3 L01/W05 | Watchlist Row role=button没有键盘处理；remove只group-hover显示；长源前缀可能挤报价，拖拽是唯一排序方式 | 键盘可选、触屏可见菜单、上下移操作；短显示名+source徽章，完整identity在详情；删除提供Undo |
| U12 | S1 L03/L04/L05/R04 | SymbolDetail的depth/tape/stats用fmt.price默认两位，ServiceReport trades统一toFixed(4)，低价币/小数数量会变0.00/0.0000 | 用identity价格精度/数量步长，未知用明确占位，不改真实值；表格格式局部可改 |
| U13 | S2 L03 | Stats以当前缓存daily序列显示Open/Day range与收益，未显式显示最后bar日期；旧范围/未知volume会给人“今天”的印象 | 写“最近可用日线 [日期]”，不足一年/30条明确覆盖；未知volume别当0；局部可改 |
| U14 | S2 W05/B01/B02 | Builder代码预览按window≥900默认展开340px，窄Dockview panel仍可能被占空；生成确认框w380在手机或窄panel溢出 | 按容器宽度控制、默认折叠源码，max-w与滚动；根代理不必改引擎 |
| U15 | S2 B01/B02/B03 | ConditionRow单行两个Operand+比较器；删除opacity0仅hover；生成说明“one-way”与可返未修改脚本并存；直接删策略无Undo | 窄panel拆左右两行，删除始终可达；统一“仅未修改生成脚本可返构建器”，删除可撤销 |
| U16 | S2 B05/B06/B07 | Composer Weight为0–1小数，threshold/above缺单位；Add equal-weight branch会重置原各分支为等权 | 显示百分比与合计；字段明确收益%/fraction；把动作叫“添加分支并全部等权”或保留比例；局部可改但需数值回归 |
| U17 | S2 P08/P09/E08 | PineHosts条目只有UUID片段；停止/失败后View disabled，完整图/事件没有稳定再次打开路径 | 人类名+标的+周期+模式；保留summary和错误，完整归档render需后端支持，应明确是缺口，不伪造恢复视图 |
| U18 | S2 P09/E11 | external mode可选但仅接fill API；local capital不reserve现金；indicator/strategy不匹配会warmup失败 | advanced入口保持，显示配置就绪与合同；按已解析kind推荐模式，不能默认全broker已支持；已有共享资金提示保留 |
| U19 | S2 A01/A03 | Alerts symbol/tf只在初次mount取chart；创建无busy锁，连续点可造重名重复提醒 | “用当前图表”显式动作；提交锁/成功定位新规则；保持用户手写draft，不盲目覆盖 |
| U20 | S2 A03/A04 | alerts.list含deleted/triggered/expired；UI全映射且非active一律Resume | Active/Paused允许操作；其它归历史/只读，状态显示原因；频率/过期时间/来源feed可展开 |
| U21 | S2 A04/O04 | ServicePaper、通知poll吞异常；多数成功poll不清过去error；后台策略/提醒源已失联无清楚就绪状态 | 稳定last-success/连接状态，不闪烁toast风暴；区分等待收盘与失败，提供下一步 |
| U22 | S3 I01/I02/I03/O01 | 普通Settings首屏为命令JSON和三个开发入口；多数方法只有{}示例，原始UUID/SQL错误在普通操作页 | 基础设置/连接优先；开发接口独立advanced tab，保留真实API，不用假schema/示例替代 |
| U23 | S2 D12/I04/I05 | ServerIntegrations传ServiceExtensions onImport空函数；CSV上传成功只有隐藏DB新快照，Workbench也仅refresh不选中新数据 | 显示导入标的/周期/数量与“用于图表/回测”，文件格式示例与解析错误定位；局部可改 |
| U24 | S2 I04/I05/O02 | Plugins页同时放usePlugins UI工具toggle与Rust plugins.enable宿主扩展，权限意义不同；enable后无Open tool | 分“工作台工具”“服务器扩展”，服务权限/启用状态与panel可见分别说明；提供打开工具动作 |
| U25 | S2 W07/O02 | Workspace Restore选JSON后立刻restore并保存，缺导入摘要/当前状态备份与覆盖说明；clipboard失败也无反馈 | 导入前显示布局/自选/脚本数量及替换范围，提供导出当前状态；复制Promise成功/失败可见，局部可改 |
| U26 | S2 E01/E05/E08 | Reset确认有，但文案只说orders/positions；与宿主local_orders外键/正在运行策略有关，可能失败或继续产生新单 | 告知会清成交与费用；运行本地策略时禁用并解释依赖；真正重置关联账本要后端合同，不能UI绕过 |
| U27 | S2 O02/E02/A03 | 已加载报价但account数据未到时executable判定可能为true；大部分写按钮未按scopes给禁用原因，只等服务403 | account/source/permissions未知时显示Loading或Read only；保留服务端校验，UI不是权限来源 |
| U28 | S3 R07/R05 | 报告垃圾桶Discard仅remove本地列表，不删除server job；JSON导出有，CSV报告导出没有正常入口 | 叫“移出当前视图”；服务器归档/删除按实际能力；CSV若必须要实现并验收，不能只改按钮文案 |
| U29 | S2 R03/R04/B08 | ServiceReport四列卡、长ISO交易宽表、manifest/pre与Composer JSON原因密集；失败error常藏details，pending只JSON | 基础结果/失败原因优先，交易表紧凑/横滚明确，持仓/待单结构化；来源manifest折叠；根代理可先改布局 |
| U30 | S2 D03/D04/E09 | MarketPanel/Settings能力卡展示rawhistory/stream/feed可能把适配当可用；night source已知路径等缺口 | 每源状态分已实测/需配置/实现待修；接数据审计结果，不能靠Capabilities名称宣称成熟 |

## 监督方实现与验收补充

这次不是仅调整四图截图：前端信息层级、共享弹层、图表容器、脚本工作区、交易输入、提醒与报告一起审查。上文U01–U30保留发现时的证据；以下记录修复后的状态，不能把旧触发条件直接当作当前缺陷，也不能将尚未处理项写成已完成。

### 与 TradingView 的具体对照

已查看TradingView官方Supercharts和Pine Editor说明及其实际界面截图：[Supercharts](https://www.tradingview.com/support/solutions/43000746464-getting-started-with-supercharts/)、[Pine Editor](https://www.tradingview.com/support/solutions/43000763320-how-to-work-with-pine-editor/)。当前官方编辑器默认浮动，可停靠右侧、放到底部或单独窗口，不能按旧版印象描述成只有底栏。本项目采用其任务组织原则；本轮没有实现TradingView所有窗口模式或宣称Pine数值等价。

| 用户任务 | 本项目原问题 | 本轮处理 |
|---|---|---|
| 选标的、周期和看图 | 每格重复三行工程诊断，窄格仍展示完整工具栏 | 32px单行工具栏；小于620px折叠次要动作，小于400px压缩报价/OHLC/指标图例；Live/Delayed/Stale等质量仍可见 |
| 查数据来源与故障 | 长provider/feed/timezone/cursor文字长期遮挡图 | 紧凑状态按钮；点击看来源、时间、延迟、缺口和错误详情 |
| 找脚本并修改 | Library混合资源，Edit跳回工作区 | 改为Scripts，Pine scripts / Visual builder / Backtest results同页；导入、编辑、回测不强制跳页 |
| 导入Pine与依赖 | 不清楚整份脚本和import模块区别 | 明确Import Pine支持粘贴/.pine/.txt；Pine dependencies保留在文件菜单进阶入口 |
| 应用脚本 | Run与Add并排但不清楚先后；重复添加 | 主动作Add to chart / Update on chart；Check script进入文件菜单；更新同脚本实例不重复添加 |
| 找常用功能 | 图标和Add panel含义依赖经验 | 导航加文字；图表区提供Pine Editor/Backtest/Paper account/Order ticket任务栏 |
| 开启自动运行 | 首屏暴露JSON、内部版本与宿主配置 | 默认选策略和数据，可使用最近回测；宿主tick、外部反馈、Composer源码和开发工具逐层展开 |
| 窄面板菜单 | 子菜单被Dockview裁切 | 共享Popover移到页面层，按视窗定位/翻转/限高，支持嵌套菜单与Escape |
| 字体和颜色一致 | 价格、诊断、普通标签混用mono，外部字体依赖 | UI/价格/图表统一Geist，代码Geist Mono；中文统一fallback，字体与OFL随应用；四主题与少动画规则 |

### 问题处理对照

- U01：已改用报告不可变快照计算基准；5项功能fixture和真实浏览器回测验证。
- U02：Automation已阻止未保存草稿执行；浏览器验证“使用最近回测→改名→禁止运行”。
- U03：已修cash/group可视化shape识别；没有借此宣称Composer所有语义已完成。
- U04/U05：非市价必须有效输入，切资产清空数量/价格；浏览器验证且未下单。
- U06：仓位工具只计算假设风险，打开订单票据；不再声称market单自带止损。小数步长建议仍需完善。
- U07：删除无实际跳转的交易行click处理；真实定位历史快照图表仍属后续功能。
- U08/U21：增加持续模拟Stop、显示会话与轮询错误；完整后台健康/所有pending终态处理仍需后续。
- U09：平仓反馈显示拒绝/状态并转Orders；Alpaca要求显式选择IEX/SIP关闭报价feed。未进行真实Alpaca联网验收。
- U10：Data默认按活动周期建议范围，1m为3天；手改日期保留，换源同步对应示例symbol；浏览器验收。
- U11：通用自选列表的触屏排序/撤销/长identity显示仍有改进空间。
- U12/U13：Depth/Tape/Stats按标的精度，明确最近日线日期；报告避免固定4位截断微小数量；旧日线和极低价fixture通过。
- U14/U15：Builder按容器而非整窗控制侧栏，源码默认折叠，窄格内嵌；条件分行、常显删除、弹窗限宽限高；手机浏览器已验证。删除撤销/转换文案仍可改善。
- U16/U17/U18：复杂组合权重表达、终态Pine Host完整归档视图、外部Broker合同仍保留为进阶缺口。
- U19/U20：提醒有同步提交锁，只允许active/paused暂停恢复；切图跟随与手动草稿区分，组件fixture通过。
- U22：普通Settings默认外观；API/CLI/MCP和权限独立页面，未增加内置AI聊天。
- U23/U24：CSV导入后自动定位、工作台工具与宿主扩展更完整合并仍待完善。
- U25：恢复工作区先验证并预览替换范围，提供取消和导出当前状态入口；浏览器验收未执行替换。
- U26：重置账户与运行宿主依赖合同仍需专门完成，未绕过后端校验。
- U27：订单票据在账户未就绪/无paper.manage权限时禁止提交；其他所有页面的权限提示一致化仍需继续。
- U28：当前无动作交易行已移除；服务器归档、报告CSV和Discard命名仍需完善。
- U29：报告指标按容器分列、交易/月收益单独横滚；复杂宿主pending/持仓的结构化展现仍可改善。
- U30：界面明确公开源与需配置源，夜盘标待修/待验收；后端问题详见数据审计。

### 本轮证据与范围

- 最终隔离浏览器构建：`var/ux-dist`，UI 18892代理独立Rust 18879；独立数据目录`var/ui-real-data-review`，不修改公共预览的账户或工作区。
- [ux-review.json](../acceptance/ux-review.json)：单/四/六图几何、嵌套菜单、Pine粘贴/编辑/Add/Update、实际本地字体。1480×760时四/六图chart-panel高280px，主canvas220px，约78.6%；toolbar31px，横向溢出0。此比例不包含Dockview外部标题栏。
- [ux-flows.json](../acceptance/ux-flows.json)：真实历史上文件导入策略产生1笔闭合交易、原地报告、版本草稿门禁、分钟范围、空价格/换标的、4主题、390px主页面、Builder与导入弹窗、恢复预览取消，无浏览器JS异常。
- [ux-components.json](../acceptance/ux-components.json)：提醒状态与重复提交、低价/旧日线、Builder容器切换；是实际组件fixture，不冒充浏览器全链路。
- TypeScript、生产构建、11项报告基准/Pine绘图/工作区文档测试通过。构建仍有大bundle警告，未做全站代码拆分。本轮未重新跑312脚本语料、全市场压力测试或重建Docker镜像，也未把96项功能清单批量改为verified。

发布补充：已将上述通过验收的静态构建更新到现有Paseo预览，保留旧资源文件并最后原子替换index；没有重启Rust或修改预览账户/工作区。构建与远程校验见[ux-release.json](../acceptance/ux-release.json)。另修复了恢复布局后图表标题未按当前标的更新的问题，浏览器已核对手机面板标题与实际symbol/timeframe一致。

## 96项对应索引

以下不重写功能验收清单，也不批量标记verified。UI现状以实际入口/操作解释；“本轮可改”通常仅指表现和引导。根代理正在变动的上下文项不另做实现。


### Data

| ID / 功能 | 清单状态 | UI现状 | 简化/进阶建议 | 本轮处理风险 |
|---|---|---|---|---|
| D01 真实美股与ETF历史数据 | verified | MarketPanel与动态搜索连接真实股票/ETF历史 | 默认源和可用日期先给选择，质量/快照放详情 | 基础；U10/U30；可改引导 |
| D02 真实加密货币历史与实时行情 | verified | Coinbase动态标的与原图表实时数据 | 切源同步标的示例，明确只含该交易所覆盖 | 基础；U10/U12；可改 |
| D03 美股实时/延迟行情订阅 | partial | Yahoo推送与Alpaca源配置存在 | 实测/未知延迟/待权限/待修分别显示 | 基础状态+高级源；U30；不能UI补全源 |
| D04 盘前、正常、盘后、隔夜时段 | partial | Yahooregular/extended与Alpaca夜盘选项 | 会话用人类时段，夜盘待修不能称就绪 | 进阶；U30；真实能力需后续 |
| D05 行情权限、来源、延迟、最后更新时间 | partial | MarketBadge能展开来源/时间/质量 | 保留关键状态，身份细节收进Popover | 基础；根代理正在处理 |
| D06 历史范围、分页、预热、缺口 | partial | MarketPanel自定义UTC范围、失败与gaps | 周期范围预检/预设、可见预热与修复入口 | 进阶；U10/U21；可改 |
| D07 时间周期与聚合 | partial | TIMEFRAMES菜单与源聚合 | 选择前说明可用周期/范围，保留实际会话 | 基础；可改标注，精度验收另计 |
| D08 形成中K线与收盘事件 | partial | 图表形成中与closed事件、Host图 | 形成中与确认柱清楚区别，未知volume别隐去 | 基础状态；U13/U18；源合同不扩大 |
| D09 断线、重连、补数、陈旧数据 | partial | 来源徽章和error存在 | 等待/断流/修复中要能定位，不吞任务错误 | 基础；U08/U21；可改 |
| D10 迟到成交与数据修订 | partial | serverbar修订诊断可传入状态 | 给用户解释停止原因及原已提交结果 | 进阶；U08；可改反馈 |
| D11 标的搜索、唯一身份、精度 | partial | SymbolSearch和canonical身份 | 短显示名保留source、正确价格/数量精度 | 基础；U11/U12；搜索根代理负责 |
| D12 CSV/JSON导入与导出 | partial | Market/Operations JSON与CSV插件导入 | 导入预览、成功定位、给格式示例；导出独立 | 进阶；U23；可改 |
| D13 多标的、多周期数据请求 | partial | PortfolioData及静态request预取路径 | 组合列标的覆盖/对齐结果，动态缺数据解释 | 进阶；U16/U18；liveMTF不能假完成 |
| D14 交易日、夏令时、提前收盘 | partial | 会话日历隐含在数据流程 | 日期选择提示休市/半日，未知范围明确 | 基础解释+进阶日历；能力验收另计 |
| D15 复权、拆股、股息与口径 | partial | 数据源复权字段，快照记录口径 | 选择明确raw/adjusted与源，不泛称收益 | 进阶；可改标注 |

### Workspace

| ID / 功能 | 清单状态 | UI现状 | 简化/进阶建议 | 本轮处理风险 |
|---|---|---|---|---|
| W01 1/2/4/6图与研究/策略/交易预设 | partial | 完整Dockview与预设、小屏上下文 | 默认看盘任务为主，保留高级多图入口 | 基础+进阶；根代理负责 |
| W02 面板拖拽停靠、尺寸、最大化 | partial | 原面板停靠最大化与Resize | 按panel宽度处理，不用window宽度推断 | 进阶；U14；根代理负责布局 |
| W03 布局创建、重命名、删除和服务器保存 | partial | workspace乐观revision同步 | 保存中/已保存/冲突稳定可见 | 基础；根代理负责 |
| W04 标的、周期、十字光标联动组 | partial | 图表联动组仍在 | 颜色配文字/可读说明，不误改未联动图 | 进阶；根代理上下文 |
| W05 主题、可访问性和小屏布局 | partial | 主题与手机布局已有回归 | 表单/宽表/hover动作仍需面板级审查 | 基础；U11/U14/U15/U29 |
| W06 命令面板与快捷键 | partial | 命令面板/快捷键保留 | 常用任务优先，开发命令折叠 | 进阶；根代理负责 |
| W07 状态导出、恢复与服务连接 | partial | 服务连接/Workspace export restore | 导入摘要、覆盖范围、备份当前状态 | 基础状态+进阶导入；U25 |

### Charts

| ID / 功能 | 清单状态 | UI现状 | 简化/进阶建议 | 本轮处理风险 |
|---|---|---|---|---|
| C01 蜡烛、OHLC、折线、面积图 | partial | 原图表样式存在 | 样式短列表不挤主工具栏 | 基础；根代理负责 |
| C02 成交量、十字光标、OHLC数据窗 | partial | OHLC/成交量/数据窗存在 | 未知volume为未知；价格时间数据可解释 | 基础；U12/U13；根代理负责 |
| C03 SMA/EMA/BB/VWAP/RSI/MACD/ATR | partial | 指标菜单和参数存在 | 常用指标基础，参数对话框次级 | 基础+进阶；根代理负责 |
| C04 Pine绘图和交易标记 | partial | ChartCanvas复用Pine线/形状/table等 | display与overlay能力保留、缺支持给诊断 | 基础结果；根代理负责 |
| C05 趋势线/水平线/矩形/斐波那契/文字 | partial | 原绘图工具存在 | 常用工具基础，其余More；键盘可达 | 基础+进阶；根代理负责 |
| C06 绘图撤销重做、显隐、锁定与对象管理 | partial | 对象管理/锁定/显隐/撤销存在 | 删除有Undo，长对象名可定位 | 进阶；根代理负责 |
| C07 缩放、自动适配、时间与价格刻度 | partial | 缩放适配与刻度存在 | 主图操作稳定，设置里显示单位时区 | 基础；根代理负责 |
| C08 图表截图与行情CSV导出 | partial | 截图/行情CSV存在 | 导出标的、范围、来源和当前视图区别 | 进阶；根代理负责 |
| C09 逐bar回放、暂停、步进、速度、重置 | partial | 图表bar回放可用 | 回放与持续模拟分名，交易跳图真正实现 | 基础+进阶；U07 |
| C10 多标的比较与基准 | partial | 比较与回测Buy&hold | 必须对应同快照；已修回测基准不取当前feed | 进阶；U01已修，其它根代理负责 |

### Watchlists

| ID / 功能 | 清单状态 | UI现状 | 简化/进阶建议 | 本轮处理风险 |
|---|---|---|---|---|
| L01 自选分组增删改、排序、添加删除标的 | partial | 自选管理/导入/排序/拖拽 | 触屏删除/上下移/Undo、keyboard选择 | 基础；U11；可本轮 |
| L02 最新价、涨跌、真实前收盘、迷你图 | partial | 报价前收盘/涨跌/迷你图存在 | NaN用中性占位，长标的/精度不遮报价 | 基础；U11/U12；可本轮 |
| L03 标的详情与统计 | partial | Stats从已加载daily计算 | 日期与历史覆盖先说明，不假称今日/全年 | 进阶；U13；可本轮 |
| L04 真实盘口与价差 | partial | Depth默认tab，Coinbase5秒REST | 无深度源先给空态，标明快照非实时L2 | 进阶；U12/U30；可本轮 |
| L05 真实逐笔成交 | partial | Tape真实事件列表与空态 | 交易时区/方向/精度正确，别把quote当trade | 进阶；U12；可本轮 |
| L06 板块热力图和仓位计算插件 | partial | 热力图与PositionSizer UI工具 | 小数精度、止损仅假设、启用后Open tool | 进阶工具；U06/U24；高优先 |

### Pine

| ID / 功能 | 清单状态 | UI现状 | 简化/进阶建议 | 本轮处理风险 |
|---|---|---|---|---|
| P01 编辑器高亮、补全、错误行、运行取消 | partial | 编辑器编译/错误/取消入口 | 脚本操作结果就近反馈，不迁JSON控制台 | 基础；根代理负责 |
| P02 输入类型、默认值、范围与图表覆盖 | partial | typed输入与服务覆盖 | 版本/输入同运行对象，原参数记录可见 | 基础；U02根代理已修 |
| P03 指标/策略库与不可变版本 | partial | Library/版本/Automation选择 | 用名字和时间识别，hash仅详情 | 基础+进阶；根代理负责 |
| P04 复杂v5/v6语言与容器 | partial | 复杂语言在引擎内，UI诊断 | 不把支持若干脚本写成全语言等价 | 进阶能力解释；后端不本轮补全 |
| P05 本地库import、版本与依赖锁 | verified | 库管理与resolve锁已接UI | 常用import在编辑流程，源码/许可在进阶 | 进阶；根代理库/编辑器上下文 |
| P06 跨标的、跨周期、预热与可见性 | partial | 静态request准备，动态需数据 | 让用户看到缺哪个symbol/tf，不只Raw error | 进阶；U18；可改诊断 |
| P07 历史原生订单语义 | partial | 原生历史策略报告 | 成交为实际原生fills，别用提示信号替代 | 基础结果；U07/U12 |
| P08 实时tick与rollback/varip | partial | PineHosts tick/varip真实UI已验收 | 移advanced，解释确认等待与不支持语义 | 开发/进阶；U17/U18；非全兼容 |
| P09 外部订单Host和成交反馈 | partial | external feedback API与Host模式 | 模式明确非已连接券商， pending结构化 | 开发；U18；能力缺口不能只改标签 |
| P10 脚本alerts/alertcondition事件 | partial | 策略通知与报告alert保存 | 到具体策略/日期，说明哪些频率真支持 | 进阶；U20/U21 |
| P11 隔离、资源限制、取消、错误传播 | partial | worker失败/取消由服务保证 | 错误与原因就近显示，取消有终态反馈 | 基础状态；U08/U21 |
| P12 固定公开脚本与兼容性矩阵 | partial | 公开语料与兼容矩阵在docs | UI有能力说明链接，保留失败与隔离复跑 | 开发诊断；无需做普通首页表格 |
| P13 TradingView同数据数值/成交对照 | planned | 未有完整TV数值/成交等价验收入口 | 不展示等价认证；比较证据另做研发 | 研发；不可UI补全 |

### StrategyBuilder

| ID / 功能 | 清单状态 | UI现状 | 简化/进阶建议 | 本轮处理风险 |
|---|---|---|---|---|
| B01 原条件树、比较、AND/OR、指标条件 | partial | 原AND/OR条件树与指标Operand | 窄panel分行，空条件明确不触发 | 进阶创建；U14/U15；可本轮 |
| B02 原仓位、止损、止盈、生成Pine | partial | 仓位/止损/止盈与资本/费/滑点 | 单位和校验就近，生成preview默认折叠 | 进阶；U14/U15；可本轮 |
| B03 Pine到构建器受支持子集 | partial | 只有未修改生成脚本可回块 | 统一两处说明，限制不隐藏 | 进阶；U15；可本轮 |
| B04 Composer资产、现金、分组 | partial | Composerasset/cash/group菜单，shape已补 | 已补选项递归，需现金/分组界面回归 | 进阶组合；U03代码已改 |
| B05 等权、指定权重、逆波动率 | partial | specified/equal/inverse volatility | 百分比总和/风险回看单位、添加比例动作解释 | 进阶组合；U16；可本轮 |
| B06 条件分支、排序和筛选 | partial | condition/filter字段直接symbol字符串 | 选同一组合数据标的，lookback/return单位 | 进阶组合；U16；可本轮 |
| B07 按bar/日/周/月/偏离阈值再平衡 | partial | bar/daily/weekly/monthly/threshold | 基础给日/周预设，bar计数与偏离放高级 | 进阶组合；U16；可本轮 |
| B08 组合回测、持续模拟与解释报告 | partial | ServiceReport决策/fills以文字JSON解释 | 结构化当前权重/资金/交易，完整原因可展开 | 进阶；U29；可本轮表现 |

### Backtest

| ID / 功能 | 清单状态 | UI现状 | 简化/进阶建议 | 本轮处理风险 |
|---|---|---|---|---|
| R01 Pine和构建器服务器回测 | partial | 编辑器/Builder与Automation服务器任务 | 统一已保存源/输入与数据选择，旧draft不可跑 | 基础；U02根代理已修 |
| R02 日期、预热、本金、费用、滑点 | partial | Builder资本费滑点、Market日期、Pine source | 正常回测流程能看到范围与原生运行设置 | 基础+进阶；入口跨页需根代理整合 |
| R03 权益、回撤、月收益、完整指标 | partial | 主报告权益回撤/月/指标，ServiceReport简报 | 基准只immutable snapshot；手机指标分层 | 基础摘要+高级指标；U01已修/U29 |
| R04 交易明细、多空、成本、开放订单 | partial | 交易宽表与manifest pendingJSON | 精度、入/出时间、持仓待单结构化 | 基础结果+进阶；U07/U12/U29 |
| R05 持久任务、取消、重试、进度、恢复 | partial | 进度status、job list、取消/重试 | loading-data无job取消说明；pending按终态操作 | 基础；U08/U21 |
| R06 源码/输入/引擎/行情快照清单 | partial | manifest/source/snapshot/input保留 | 人类摘要在前，完整复现清单折叠复制 | 进阶；U02已修/U22 |
| R07 报告CSV/JSON导出和版本比较 | partial | 主报告JSON与2run简单比较 | CSV入口仍缺；移出视图不等于删除serverjob | 进阶；U28；功能补齐另验 |

### Trading

| ID / 功能 | 清单状态 | UI现状 | 简化/进阶建议 | 本轮处理风险 |
|---|---|---|---|---|
| E01 服务器手动模拟账户 | partial | ServerAccount权威模拟账本 | 明确USD、本地、共享账户，更新/错误可见 | 基础；U26/U27；可本轮说明 |
| E02 市价/限价/止损委托 | partial | 票据market/limit/stop/stop-limit | 非市价必须明确输入；切标的不得沿用旧价 | 基础；U04/U05；优先可改 |
| E03 撤单、改单、平仓、部分退出 | partial | Account改单撤单平仓；卖出可部分退出 | 提交结果与feed不猜，及时跳至订单 | 基础；U09；部分需接口协调 |
| E04 多空、仓位、权益和风险限制 | partial | position/equity/risk由服务校验 | 先显示账户就绪/限制，不把Sizer当保护单 | 基础；U06/U27 |
| E05 订单/成交/持仓历史和导出 | partial | 订单/成交/仓位table，Export JSON | 新操作定位到对应tab/条目，feed可追溯 | 基础+进阶历史；U09/U29 |
| E06 Pine从回测部署到真实行情本地模拟 | verified | 回测Deploy真实closed-bar native session | 明确等待下一确认bar，name与stop结果可见 | 进阶自动化；U08 |
| E07 Composer真实多标的持续模拟 | partial | Composer保存/组合数据/持续部署入口 | 同标的组合覆盖与对齐，显示原因/真实结果 | 进阶自动化；U03/U16/U29 |
| E08 暂停、恢复、停止、pending失败处理 | partial | 两套session controls分散在多页 | 统一停止/终态/错误/pending处理显示 | 进阶；U08/U17/U26 |
| E09 Alpaca Paper联网闭环 | blocked_external | Live broker dialog与Alpaca配置说明 | 不能显示为已连，Paper与Live权限区别 | 进阶连接；U30；外部条件仍阻塞 |
| E10 图上订单/持仓与交易操作 | partial | 图上订单/持仓与动作由ChartTrading | 同账户/来源/报价，确认操作不造成功 | 基础交易+进阶；根代理图表上下文 |
| E11 DEMO、真实行情、本地模拟、券商模拟区分 | partial | Demo/Server account标签与Host模式 | 纸账户/历史回放/持续执行/实际券商区别 | 基础；U05/U06/U18 |

### Alerts

| ID / 功能 | 清单状态 | UI现状 | 简化/进阶建议 | 本轮处理风险 |
|---|---|---|---|---|
| A01 价格above/below/cross提醒 | partial | above/below/cross表单可创建 | 当前图表一键填入、价格默认提示、成功定位 | 基础；U19；可本轮 |
| A02 指标/策略提醒与收盘触发 | partial | Pine strategy通知列表/历史报告alerts | 同名会话用策略名，和价格提醒分组 | 进阶；U17/U20 |
| A03 创建、暂停、恢复、删除、到期、频率 | partial | 频率到期可选，列表Pause/Delete | terminal不再给Resume，创建锁避免重复 | 基础+高级频率；U19/U20 |
| A04 提醒历史、失败状态、站内通知 | partial | 历史列表与站内toast | 失败与最后成功检查可见，不吞掉断流状态 | 基础；U21；可本轮 |

### Extensions

| ID / 功能 | 清单状态 | UI现状 | 简化/进阶建议 | 本轮处理风险 |
|---|---|---|---|---|
| I01 统一API、CLI、MCP命令 | partial | Settings真实ServerIntegrationsAPI/CLI/MCP | 开发入口后置，真实command names与权限保留 | 开发；U22 |
| I02 工作区与图表外部控制 | partial | Workspace get/save外部控制 | UI导入覆盖有摘要，勿称全部browser命令直通API | 开发；U25 |
| I03 TS/Python SDK和schema发现 | partial | SDK/schema文档与MCP命令工具 | 各方法字段样例/跳doc，不普遍给{}误导 | 开发；U22；完整schema需后续 |
| I04 插件清单、启停、版本与权限 | partial | UI工具toggle与hostplugin列表 | 权限层级分开，不混成单一Enable意义 | 进阶/开发；U24；可本轮 |
| I05 数据/指标/面板/命令插件示例 | partial | CSV/equity-report与UI工具示例 | import/enable后能找到数据/打开结果 | 进阶；U23/U24；可本轮 |
| I06 可替换Data/Chart/Runtime/Backtest/Broker接口 | partial | Adapters页原始capability/接口列表 | 标明实现/仅契约/未验收，别对用户说全可替换已完成 | 开发；U22/U30 |
| I07 不内置AI聊天与模型账户 | verified | 无内置AI聊天 | 保留API/MCP，不占基础导航的聊天入口 | 符合用户；无需新功能 |

### Operations

| ID / 功能 | 清单状态 | UI现状 | 简化/进阶建议 | 本轮处理风险 |
|---|---|---|---|---|
| O01 React+Rust本地/服务器自托管 | partial | React工作台+Rust服务+Node Pine | 正常页面不让用户先理解数据库/worker | 基础；U22；当前根代理在改 |
| O02 令牌、权限、撤销、敏感信息保护 | partial | 连接token+server scopes，Settings权限读列表 | Read only/未就绪禁用理由，权限由服务判定 | 基础连接+运维；U27 |
| O03 SQLite迁移、单实例、备份与恢复 | verified | 迁移/锁/备份恢复在CLI/docs，非普通UI按钮 | 运维页给明确文档，不制造不存在的备份按钮 | 运维；已有功能不需基础UI硬塞 |
| O04 服务健康、数据健康、日志与诊断 | partial | 数据Badge/错误/能力与APIhealth | 稳定原因/最后成功/下一步，人类消息加详情ID | 基础状态+诊断；U21/U22 |
| O05 Docker/Compose实际运行 | partial | Compose与实测Docker报告，非UI配置安装器 | 展示部署文档及已验收镜像时间，不编造云一键部署 | 运维；外部部署另验 |
| O06 依赖锁、许可和开源发布 | blocked_external | 依赖lock/许可证/原源码授权边界 | 许可信息在About/docs；不用开源标签覆盖行情许可 | 运维；外部阻塞不由UI解除 |
| O07 端到端真实数据验收与功能门禁 | partial | 96项gate与真实browser证据在docs | 能力可解释，不能用按钮数量当验收完成 | 运维/研发；本审计不改statuses |
| O08 Paseo远程访问与持久服务 | partial | Paseo17915持久Rust预览独立DB | 用户知道访问的是哪个实例、关闭网页不停止服务 | 基础连接+运维；只读核查，不改服务 |

## 本轮验收建议

先修语义与阻断，再改视觉密度：空价格不下单、切标的票据不沿用旧价（代码已改，待回归）、Sizer不承诺不存在的保护单（代码已改）、Cash/Group可正常编辑、历史报告空缓存可打开、持续任务错误/停止可见、提醒终态不误给Resume。其余再做窄panel和文字清理。

使用隔离测试实例/数据目录完成：手机320–390px与桌面窄Dockview panel；同一标的两源/两周期；无行情/断流/只读token；已保存报告但无对应缓存；切图后限价草稿；partial/pending/failed/stopped任务；导入成功定位；终态提醒；插件启用后结果入口。测试不得向真实券商下单，也不在公共预览写入验收数据。

本次基准函数验证是隔离fixture，不等于整页浏览器通过；剩余项不会因文字变简洁就变成verified。已有真实图表/逐bar回放/未来闭柱模拟/宿主tick与mobile证据仍保留，简化必须回归这些功能，不重新以假数据替代。

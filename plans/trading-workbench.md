# Plan: "Meridian" — Open-Source Trading Workbench (Frontend)

## Goal
A desktop-first (≥1280px), highly interactive trading workbench in the existing React 19 + Vite + Tailwind v4 scaffold. TradingView-grade chart clarity, Composer-style visual strategy building, OpenBB-style modular workspaces, full Pine flow (edit → apply indicator → backtest strategy), paper trading clearly separated from live, and an agent-operable surface (MCP / CLI / API / plugins) — **no AI chat UI**.

## Success criteria
- Multi-chart, resizable, linkable workspace that can be saved/switched/restored (localStorage).
- Watchlist ↔ chart symbol linking via color link groups.
- Indicators + drawing tools on canvas charts with crosshair, pan, zoom.
- Pine editor: edit, compile (mock parser), add-to-chart as indicator, run strategy backtest with equity curve, trades list, metrics.
- Visual strategy builder (block tree) that compiles to Pine and backtests through the same engine.
- Paper trading: order ticket, positions, orders, fills; persistent "SIMULATED" badges; Live mode locked behind a disabled broker connection.
- Integrations hub: MCP server, CLI, REST/WS API, plugins, data/broker adapters (Lightweight Charts, PineTS, LEAN listed as adapters).
- Light + dark themes, polished motion; 60fps chart interaction.

## Dependencies to add
`zustand` (state + persist), `lucide-react` (icons), `motion` (UI animation). Charts are a custom Canvas2D renderer behind a `ChartEngine` interface (keeps door open for Lightweight Charts/Vela). No editor lib: Pine editor is a textarea-overlay with custom tokenizer highlighting + line numbers.

## Architecture (`src/`)
```
core/
  types.ts            Bar, Symbol, Indicator, Drawing, Order, Position, Panel, Workspace
  registry.ts         module registry: panels, indicators, data feeds, brokers, plugins
  commands.ts         command bus: every action is a typed command (id, params schema, run)
                      -> powers Command Palette, keyboard shortcuts, and the "Agent API" view
data/
  symbols.ts          ~16 US tickers (AAPL, MSFT, NVDA, TSLA, AMZN, META, GOOGL, SPY, QQQ, AMD, JPM, XOM, NFLX, COIN, PLTR, IWM) with realistic base prices/sectors
  feed.ts             seeded deterministic GBM bars (D/1h/15m/5m), ~1000 bars; live tick simulator (setInterval 1s jitters last bar)
indicators/           SMA, EMA, BB, RSI, MACD, VWAP, Volume (pure fns over Bar[])
pine/
  tokenizer.ts        highlight tokens
  interpreter.ts      subset: indicator()/strategy(), inputs, ta.sma/ema/rsi/crossover/crossunder, plot, strategy.entry/close; errors with line numbers
backtest/engine.ts    bar-by-bar sim: signals -> trades, commission/slippage, metrics (net %, CAGR, Sharpe, max DD, win rate, profit factor), equity + drawdown series
trading/paper.ts      paper broker: market/limit/stop, fills against simulated ticks, P&L
store/                workspace, market, trading, settings stores (zustand persist)
ui/                   primitives: Button, IconButton, Tabs, Segmented, Tooltip, Popover, Badge, Input, Kbd, Toggle
features/
  shell/              TopBar, LeftRail, StatusBar, CommandPalette (⌘K), ThemeToggle
  workspace/          WorkspaceGrid (recursive split tree, drag dividers), PanelFrame (header, link color, maximize, close, swap type), layout presets
  chart/              ChartPanel, CanvasChart (candles/line/area, volume, overlays, sub-panes for RSI/MACD), crosshair+OHLC legend, DrawingToolbar (trendline, horizontal, rect, fib, text), IndicatorPicker
  watchlist/          lists, sparklines, flash on tick, sort, add symbol
  pine/               PineEditor, console, "Add to chart", "Backtest" actions
  builder/            StrategyBuilder (Composer-like nested blocks: If/Else, Condition, Weight, Asset, Rebalance), live Pine preview
  backtest/           BacktestReport (metrics cards, equity/drawdown chart, trades table, monthly heatmap)
  trading/            OrderTicket, Positions/Orders/Fills tabs, account summary
  integrations/       Connections hub page
```

## Layout & screens
- **Top bar**: logo, workspace tabs (+ new, rename, duplicate), symbol search, timeframe, command palette trigger, Paper/Live segmented (Live disabled w/ tooltip "Connect a broker"), theme toggle.
- **Left rail**: Workspace, Strategy Lab, Backtests, Integrations, Settings.
- **Workspace view**: split-tree grid. Panel types: Chart, Watchlist, Pine Editor, Strategy Builder, Backtest Report, Order Ticket, Positions, News/Calendar(mock), Depth/Time&Sales(mock). Presets: "Research" (2×2 charts + watchlist), "Trade" (chart + ticket + positions), "Strategy" (builder + pine + backtest).
- **Linking**: each panel has link group (none/blue/amber/green/violet); symbol change propagates within group.
- **Status bar**: feed status, "SIMULATED DATA" pill, MCP server status (e.g. "MCP · 2 agents connected"), latency, clock (ET, market open/closed).

## Pine flow
1. Default script tabs: "EMA Cross Strategy", "RSI Bands Indicator".
2. Compile (⌘↵) → console shows errors with clickable line numbers or success.
3. "Add to chart" → overlay on linked chart, appears in legend with toggle/remove/settings (inputs editable).
4. For `strategy()`: "Run backtest" → Backtest Report panel opens/focuses with results; trade markers drawn on chart. Report header labelled "Backtest · Hypothetical results".

## Strategy builder
Nested card tree, drag-reorder, inline selects (indicator, comparator, value), asset weights; side preview shows generated Pine; "Backtest" uses same engine; "Deploy to paper" creates a paper-running strategy listed in Positions panel.

## Paper vs live separation
Amber accent + hatched badge "PAPER" on ticket, positions, fills and status bar; order confirmation toast "Simulated fill". Live mode never executes; shows locked state.

## Integrations hub (agent-native)
Cards with status/toggles: MCP Server (endpoint `mcp://localhost:7337`, tool list auto-generated from command registry, token copy, connected-agent activity log of mocked agent commands affecting the UI), CLI (`meridian chart open NVDA --tf 1h` examples, copy), REST/WebSocket API (endpoint table), Plugins (installed/marketplace mock: Lightweight Charts renderer, PineTS runtime, LEAN backtest engine, Polygon/Alpaca feeds, IBKR broker), permissions scopes (read market, write workspace, paper trade, live trade off). An "Agent activity" timeline replaces chat — agent actions are visible as events, not conversation.

## Visual language
- Neutral graphite dark (#0B0D10 base) / warm paper light (#F7F7F5); single signature accent (electric indigo `#6E6BFF`), up/down teal `#16C79A` / coral `#F2545B`.
- Tailwind v4 `@theme` tokens + CSS variables switched by `[data-theme]`.
- Inter for UI, JetBrains Mono for numbers/code (Google Fonts import), tabular-nums.
- Liquid glass only on floating layers (palette, popovers, top bar) with backdrop-blur + subtle specular border; a low-cost WebGL/CSS gradient shader only in the top-bar background & empty states, paused when hidden, disabled with prefers-reduced-motion.
- Motion: panel enter/maximize springs, price tick flash, divider hover glow, tab indicator layout animation. Charts themselves remain flat and crisp.

## Interactions
⌘K palette (all commands), keyboard: `1-6` timeframes, `Alt+T` trendline, `Esc` cancel drawing, `⌘S` save workspace, `/` symbol search. Chart: wheel zoom, drag pan, double-click reset.

## Implementation order
1. Tokens/theme, primitives, shell.  2. Data feed + store.  3. Canvas chart + indicators + drawings.  4. Workspace grid, panels, linking, save.  5. Watchlist.  6. Pine tokenizer/interpreter/editor.  7. Backtest engine + report.  8. Strategy builder.  9. Paper trading.  10. Integrations hub + command palette + agent activity.  11. Motion/shader polish, light mode QA.

## Verification
`pnpm build` once at the end (broad change); manual check in preview: theme toggle, resize panels, link symbol change, Pine add/backtest, paper order fill, save/reload workspace.

## Out of scope
Real data, real broker execution, auth, mobile layout, full Pine language.

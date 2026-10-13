import type { Script } from '../core/types'

export const EXAMPLE_SCRIPTS: Script[] = [
  {
    id: 'ex-ema-cross',
    name: 'EMA Cross Strategy',
    kind: 'strategy',
    origin: 'example',
    updatedAt: Date.now(),
    source: `//@version=5
strategy("EMA Cross", overlay=true)

fastLen = input.int(12, "Fast length", minval=1)
slowLen = input.int(34, "Slow length", minval=2)

fast = ta.ema(close, fastLen)
slow = ta.ema(close, slowLen)

if ta.crossover(fast, slow)
    strategy.entry("Long", strategy.long)
if ta.crossunder(fast, slow)
    strategy.close("Long")

plot(fast, "Fast", color=#8b7dff)
plot(slow, "Slow", color=#f4b545)
`,
  },
  {
    id: 'ex-rsi-bands',
    name: 'RSI Bands',
    kind: 'indicator',
    origin: 'example',
    updatedAt: Date.now(),
    source: `//@version=5
indicator("RSI Bands", overlay=false)

len = input.int(14, "RSI length", minval=2)
smooth = input.int(9, "Signal", minval=1)

r = ta.rsi(close, len)
sig = ta.sma(r, smooth)

plot(r, "RSI", color=#4ee6d2)
plot(sig, "Signal", color=#f4b545)
`,
  },
  {
    id: 'ex-keltner',
    name: 'Keltner Channel',
    kind: 'indicator',
    origin: 'example',
    updatedAt: Date.now(),
    source: `//@version=5
indicator("Keltner Channel", overlay=true)

len = input.int(20, "Length", minval=1)
mult = input.float(2.0, "Multiplier", minval=0.1)

basis = ta.ema(close, len)
rng = ta.atr(len)

plot(basis, "Basis", color=#f472b6)
plot(basis + rng * mult, "Upper", color=#f472b6)
plot(basis - rng * mult, "Lower", color=#f472b6)
`,
  },
  {
    id: 'ex-breakout',
    name: 'Donchian Breakout',
    kind: 'strategy',
    origin: 'example',
    updatedAt: Date.now(),
    source: `//@version=5
strategy("Donchian Breakout", overlay=true)

entryLen = input.int(40, "Entry channel", minval=5)
exitLen = input.int(15, "Exit channel", minval=2)

upper = ta.highest(high, entryLen)[1]
lower = ta.lowest(low, exitLen)[1]

if close > upper
    strategy.entry("Breakout", strategy.long)
if close < lower
    strategy.close("Breakout")

plot(upper, "Upper", color=#22c58f)
plot(lower, "Lower", color=#f2545f)
`,
  },
]

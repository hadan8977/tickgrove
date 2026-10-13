import type { ComponentType } from 'react'
import { registerCommand } from '../core/commands'
import { atr, registerIndicator, type Series } from '../indicators/registry'
import { usePlugins } from '../store'
import { livePrice } from '../data/feed'
import PositionSizer from './PositionSizer'
import SectorHeatmap from './SectorHeatmap'

export interface PluginManifest {
  id: string
  name: string
  version: string
  author: string
  description: string
  permissions: ('read:market' | 'write:workspace' | 'paper:trade' | 'live:trade')[]
  contributes: { commands?: string[]; indicators?: string[]; panels?: string[]; adapters?: string[] }
  activate: () => (() => void)[]
}

const pluginPanels = new Map<string, { title: string; component: ComponentType }>()
export const getPluginPanel = (id: string) => pluginPanels.get(id)
export const listPluginPanels = () => [...pluginPanels.entries()].map(([id, v]) => ({ id, ...v }))
const panelListeners = new Set<() => void>()
export const subscribePluginPanels = (l: () => void) => {
  panelListeners.add(l)
  return () => panelListeners.delete(l)
}
function registerPanel(id: string, title: string, component: ComponentType) {
  pluginPanels.set(id, { title, component })
  panelListeners.forEach((l) => l())
  return () => {
    pluginPanels.delete(id)
    panelListeners.forEach((l) => l())
  }
}

export const PLUGINS: PluginManifest[] = [
  {
    id: 'oc.supertrend',
    name: 'Supertrend',
    version: '1.2.0',
    author: 'open-composer',
    description: 'ATR-based trailing trend indicator, contributed as an overlay.',
    permissions: ['read:market'],
    contributes: { indicators: ['supertrend'] },
    activate: () => [
      registerIndicator({
        id: 'supertrend',
        name: 'Supertrend',
        short: 'ST',
        description: 'Plugin · ATR trailing stop that flips with trend.',
        overlay: true,
        pluginId: 'oc.supertrend',
        inputs: [
          { key: 'length', label: 'ATR length', type: 'int', default: 10, min: 1 },
          { key: 'mult', label: 'Multiplier', type: 'float', default: 3, min: 0.5 },
        ],
        compute: (bars, i) => {
          const a = atr(bars, i.length)
          const up: Series = []
          const dn: Series = []
          let trend = 1
          let fu = 0
          let fl = 0
          bars.forEach((b, k) => {
            if (a[k] === null) {
              up.push(null)
              dn.push(null)
              return
            }
            const mid = (b.high + b.low) / 2
            const bu = mid + i.mult * (a[k] as number)
            const bl = mid - i.mult * (a[k] as number)
            const pc = bars[k - 1]?.close ?? b.close
            fu = bu < fu || pc > fu || fu === 0 ? bu : fu
            fl = bl > fl || pc < fl || fl === 0 ? bl : fl
            if (trend === 1 && b.close < fl) trend = -1
            else if (trend === -1 && b.close > fu) trend = 1
            up.push(trend === 1 ? fl : null)
            dn.push(trend === -1 ? fu : null)
          })
          return [
            { title: 'Up', kind: 'line', color: '#22c58f', data: up, width: 2 },
            { title: 'Down', kind: 'line', color: '#f2545f', data: dn, width: 2 },
          ]
        },
      }),
    ],
  },
  {
    id: 'oc.position-sizer',
    name: 'Position Sizer',
    version: '0.4.1',
    author: 'community',
    description: 'Risk-based sizing panel plus a `risk.size` command agents can call.',
    permissions: ['read:market', 'write:workspace'],
    contributes: { panels: ['position-sizer'], commands: ['risk.size'] },
    activate: () => [
      registerPanel('position-sizer', 'Position Sizer', PositionSizer),
      registerCommand<{ symbol: string; equity: number; riskPct: number; stopPct: number }>({
        id: 'risk.size',
        title: 'Compute position size',
        category: 'Plugin',
        pluginId: 'oc.position-sizer',
        description: 'Shares to buy so a stop-out loses riskPct of equity.',
        scope: 'read',
        params: {
          symbol: { type: 'string', required: true, description: 'Ticker' },
          equity: { type: 'number', default: 100000, description: 'Account equity' },
          riskPct: { type: 'number', default: 1, description: 'Risk per trade %' },
          stopPct: { type: 'number', default: 5, description: 'Stop distance %' },
        },
        run: ({ symbol, equity, riskPct, stopPct }) => {
          const p = livePrice(symbol)
          const qty = Math.floor((equity * riskPct) / 100 / ((p * stopPct) / 100))
          return `${qty} ${symbol} @ ${p.toFixed(2)} (stop ${(p * (1 - stopPct / 100)).toFixed(2)})`
        },
      }),
    ],
  },
  {
    id: 'oc.sector-heatmap',
    name: 'Sector Heatmap',
    version: '0.2.0',
    author: 'community',
    description: 'Treemap-style panel of watchlist performance by sector.',
    permissions: ['read:market'],
    contributes: { panels: ['sector-heatmap'] },
    activate: () => [registerPanel('sector-heatmap', 'Sector Heatmap', SectorHeatmap)],
  },
]

const active = new Map<string, (() => void)[]>()
export function syncPlugins() {
  const enabled = usePlugins.getState().enabled
  for (const p of PLUGINS) {
    const on = !!enabled[p.id]
    if (on && !active.has(p.id)) active.set(p.id, p.activate())
    if (!on && active.has(p.id)) {
      active.get(p.id)!.forEach((d) => d())
      active.delete(p.id)
    }
  }
}
export function initPlugins() {
  syncPlugins()
  usePlugins.subscribe(syncPlugins)
}

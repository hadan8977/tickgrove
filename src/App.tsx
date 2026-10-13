import { useEffect, useState } from 'react'
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import { execute, listCommands, commandSchema, getActivity } from './core/commands'
import { exportState, registerCoreCommands, tickPaperStrategies } from './core/actions'
import { initPlugins } from './plugins'
import { subscribeTicks } from './data/feed'
import { useApp, usePaper } from './store'
import Workspace from './features/workspace/Workspace'
import Integrations from './features/integrations/Integrations'
import LibraryPage from './features/library/LibraryPage'
import CommandPalette from './features/shell/CommandPalette'
import Shader, { pulseField } from './features/shell/Shader'
import { LiveDialog, Rail, Splash, StatusBar, Toasts, TopBar, useShortcuts } from './features/shell/Shell'

// ---- one-time bootstrap (module scope survives HMR re-renders) ----
let booted = false
function boot() {
  if (booted) return
  booted = true
  registerCoreCommands()
  initPlugins()
  // Public in-page agent surface. MCP/CLI/REST bridges call into the same registry.
  ;(window as any).openComposer = {
    version: '0.1.0',
    mode: 'DEMO',
    commands: () => listCommands().filter((c) => !c.hidden).map((c) => ({ id: c.id, title: c.title, description: c.description, scope: c.scope, inputSchema: commandSchema(c) })),
    execute: (id: string, params?: Record<string, unknown>) => execute(id, params ?? {}, 'agent'),
    state: exportState,
    activity: () => getActivity().slice(0, 50),
  }
  let n = 0
  subscribeTicks((prices) => {
    const fills = usePaper.getState().processTick(prices)
    for (const f of fills) useApp.getState().toast({ title: `Simulated fill · ${f.side.toUpperCase()} ${f.qty} ${f.symbol}`, body: `@ ${f.price.toFixed(2)} · working order triggered`, tone: 'demo' })
    if (++n % 5 === 0) tickPaperStrategies()
  })
}
boot()

export default function App() {
  const theme = useApp((s) => s.theme)
  const view = useApp((s) => s.view)
  const [splash, setSplash] = useState(() => !sessionStorage.getItem('oc.splash'))
  useShortcuts()
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  useEffect(() => {
    pulseField(0.02, 0.1 + (view === 'workspace' ? 0 : view === 'library' ? 0.05 : 0.1))
  }, [view])
  useEffect(() => {
    document.title = 'Open Composer'
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (!link) {
      link = document.createElement('link')
      link.rel = 'icon'
      document.head.appendChild(link)
    }
    link.type = 'image/svg+xml'
    link.href = '/favicon.svg'
  }, [])
  return (
    <MotionConfig reducedMotion="user">
    <div className="relative isolate flex h-full flex-col bg-bg text-text">
      <Shader interactive className="pointer-events-none absolute inset-0 -z-10 h-full w-full" intensity={view === 'workspace' ? 0.75 : 1} />
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <Rail />
        <main className="relative min-w-0 flex-1">
          <div className={view === 'workspace' ? 'h-full transition-opacity duration-200' : 'invisible h-full opacity-0'}>
            <Workspace />
          </div>
          <AnimatePresence>
            {view !== 'workspace' && (
              <motion.div key={view} initial={{ opacity: 0, y: 14, scale: 0.985, filter: 'blur(6px)' }} animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }} exit={{ opacity: 0, y: 8, filter: 'blur(4px)' }} transition={{ type: 'spring', stiffness: 300, damping: 32 }} className="absolute inset-0 z-10">
                {view === 'integrations' ? <Integrations /> : <LibraryPage />}
              </motion.div>
            )}
          </AnimatePresence>
        </main>
      </div>
      <StatusBar />
      <CommandPalette />
      <LiveDialog />
      <Toasts />
      <AnimatePresence>
        {splash && (
          <Splash
            onDone={() => {
              sessionStorage.setItem('oc.splash', '1')
              setSplash(false)
            }}
          />
        )}
      </AnimatePresence>
    </div>
    </MotionConfig>
  )
}

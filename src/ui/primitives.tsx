import React, { useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { ConnectionStatus } from '../core/types'

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'subtle' | 'danger' | 'up' | 'down'; size?: 'sm' | 'md' }
export function Button({ variant = 'subtle', size = 'md', className, ...p }: BtnProps) {
  return (
    <button
      {...p}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-[background,color,box-shadow,transform] duration-150 active:scale-[0.97] disabled:opacity-40 disabled:pointer-events-none select-none',
        size === 'sm' ? 'h-7 px-2.5 text-[12px]' : 'h-8 px-3 text-[12.5px]',
        variant === 'primary' && 'bg-accent text-accent-ink shadow-[0_0_0_1px_color-mix(in_srgb,var(--accent)_60%,transparent),0_6px_20px_-8px_var(--accent)] hover:brightness-110',
        variant === 'subtle' && 'bg-panel-2 text-text border border-line hover:bg-panel-3 hover:border-line-2',
        variant === 'ghost' && 'text-muted hover:text-text hover:bg-panel-2',
        variant === 'danger' && 'bg-down/12 text-down hover:bg-down/20',
        variant === 'up' && 'bg-up text-white hover:brightness-110',
        variant === 'down' && 'bg-down text-white hover:brightness-110',
        className,
      )}
    />
  )
}

export function IconButton({ active, className, label, ...p }: React.ComponentProps<'button'> & { active?: boolean; label: string }) {
  return (
    <button
      aria-label={label}
      title={label}
      {...p}
      className={cx(
        'inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-colors disabled:opacity-35',
        active ? 'bg-panel-3 text-text shadow-[inset_0_0_0_1px_var(--line-2)]' : 'text-muted hover:text-text hover:bg-panel-2',
        className,
      )}
    />
  )
}

export function Segmented<T extends string>({ value, options, onChange, size = 'sm', layoutId }: { value: T; options: { value: T; label: ReactNode; disabled?: boolean; title?: string }[]; onChange: (v: T) => void; size?: 'sm' | 'md'; layoutId: string }) {
  return (
    <div className="inline-flex rounded-lg bg-panel-2 p-0.5 border border-line">
      {options.map((o) => (
        <button
          key={o.value}
          title={o.title}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={cx('relative rounded-md font-medium transition-colors disabled:cursor-not-allowed', size === 'sm' ? 'h-6 px-2 text-[11.5px]' : 'h-7 px-3 text-[12px]', value === o.value ? 'text-text' : 'text-muted hover:text-text', o.disabled && 'opacity-50')}
        >
          {value === o.value && <motion.span layoutId={layoutId} className="absolute inset-0 rounded-md bg-panel shadow-[0_1px_2px_rgba(0,0,0,0.25),inset_0_0_0_1px_var(--line-2)]" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
          <span className="relative inline-flex items-center gap-1">{o.label}</span>
        </button>
      ))}
    </div>
  )
}

const STATUS: Record<ConnectionStatus, { label: string; cls: string }> = {
  demo: { label: 'DEMO', cls: 'text-demo bg-demo/12 ring-demo/30' },
  'not-connected': { label: 'NOT CONNECTED', cls: 'text-nc bg-nc/10 ring-nc/25' },
  live: { label: 'LIVE', cls: 'text-live bg-live/12 ring-live/35' },
}
export function StatusBadge({ status, className, hatch = false }: { status: ConnectionStatus; className?: string; hatch?: boolean }) {
  const s = STATUS[status]
  return (
    <span className={cx('inline-flex h-[18px] items-center gap-1 rounded px-1.5 text-[10px] font-semibold tracking-[0.08em] ring-1 ring-inset num', s.cls, hatch && 'hatch', className)}>
      <span className={cx('size-1.5 rounded-full', status === 'demo' && 'bg-demo', status === 'not-connected' && 'border border-nc', status === 'live' && 'bg-live')} />
      {s.label}
    </span>
  )
}

export function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx('inline-flex h-[18px] items-center rounded px-1.5 text-[10.5px] font-medium bg-panel-3 text-muted', className)}>{children}</span>
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="num inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-line-2 bg-panel-2 px-1 text-[10px] text-muted">{children}</kbd>
}

export function Input({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...p} className={cx('h-8 w-full rounded-lg border border-line bg-panel-2 px-2.5 text-[12.5px] text-text outline-none placeholder:text-faint focus:border-accent/60 focus:ring-2 focus:ring-accent/15 transition', className)} />
}
export function Select({ className, children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...p} className={cx('h-7 rounded-md border border-line bg-panel-2 px-1.5 text-[12px] text-text outline-none focus:border-accent/60 cursor-pointer', className)}>
      {children}
    </select>
  )
}

export function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)} className={cx('relative h-[18px] w-8 shrink-0 rounded-full transition-colors disabled:opacity-40', checked ? 'bg-accent' : 'bg-panel-3 ring-1 ring-inset ring-line-2')}>
      <motion.span layout transition={{ type: 'spring', stiffness: 600, damping: 35 }} className={cx('absolute top-[2px] size-[14px] rounded-full bg-white shadow', checked ? 'right-[2px]' : 'left-[2px]')} />
    </button>
  )
}

export function Popover({ trigger, children, align = 'left', side = 'bottom', className, open: controlled, onOpenChange }: { trigger: (o: { open: boolean; toggle: () => void }) => ReactNode; children: ReactNode | ((close: () => void) => ReactNode); align?: 'left' | 'right'; side?: 'top' | 'bottom'; className?: string; open?: boolean; onOpenChange?: (o: boolean) => void }) {
  const [inner, setInner] = useState(false)
  const open = controlled ?? inner
  const setOpen = (o: boolean) => (onOpenChange ? onOpenChange(o) : setInner(o))
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('pointerdown', h)
    window.addEventListener('keydown', k)
    return () => {
      window.removeEventListener('pointerdown', h)
      window.removeEventListener('keydown', k)
    }
  })
  return (
    <div ref={ref} className="relative">
      {trigger({ open, toggle: () => setOpen(!open) })}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: side === 'top' ? 6 : -6, scale: 0.96, filter: 'blur(4px)' }}
            animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: side === 'top' ? 4 : -4, scale: 0.98, filter: 'blur(2px)' }}
            transition={{ type: 'spring', stiffness: 520, damping: 34, mass: 0.7 }}
            style={{ transformOrigin: `${align === 'right' ? 'right' : 'left'} ${side === 'top' ? 'bottom' : 'top'}` }}
            className={cx('glass absolute z-50 rounded-xl p-1.5', side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5', align === 'right' ? 'right-0' : 'left-0', className)}
          >
            {typeof children === 'function' ? children(() => setOpen(false)) : children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export function MenuItem({ children, onClick, active, right, disabled }: { children: ReactNode; onClick?: () => void; active?: boolean; right?: ReactNode; disabled?: boolean }) {
  return (
    <button disabled={disabled} onClick={onClick} className={cx('flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] transition-colors disabled:opacity-40', active ? 'bg-panel-3 text-text' : 'text-text/90 hover:bg-panel-3/70')}>
      <span className="flex flex-1 items-center gap-2">{children}</span>
      {right}
    </button>
  )
}

export function Empty({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      {icon && <div className="mb-1 grid size-10 place-items-center rounded-xl bg-panel-2 text-muted ring-1 ring-line">{icon}</div>}
      <div className="text-[13px] font-medium">{title}</div>
      {body && <div className="max-w-[280px] text-[12px] text-muted">{body}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

export const fmt = {
  price: (v: number) => (v >= 1000 ? v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : v.toFixed(2)),
  pct: (v: number, sign = true) => `${sign && v > 0 ? '+' : ''}${v.toFixed(2)}%`,
  money: (v: number) => `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
  compact: (v: number) => Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(v),
}

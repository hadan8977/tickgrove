/**
 * Open Composer brand mark: an open ring ("O") broken at the upper right,
 * with three composed nodes linked along its arc — composition + openness.
 */
type Variant = 'color' | 'mono'

export function LogoMark({ size = 24, variant = 'color', className }: { size?: number; variant?: Variant; className?: string }) {
  const id = 'ocg'
  const stroke = variant === 'mono' ? 'currentColor' : `url(#${id})`
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={className} aria-label="Open Composer">
      {variant === 'color' && (
        <defs>
          <linearGradient id={id} x1="4" y1="28" x2="28" y2="4" gradientUnits="userSpaceOnUse">
            <stop stopColor="var(--accent)" />
            <stop offset="1" stopColor="var(--accent-2)" />
          </linearGradient>
        </defs>
      )}
      <path d="M24.5 8.2A11 11 0 1 0 27 16" stroke={stroke} strokeWidth="3.2" strokeLinecap="round" />
      <path d="M11 19.5 16 12.5l5 4" stroke={variant === 'mono' ? 'currentColor' : 'var(--text)'} strokeOpacity="0.55" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="11" cy="19.5" r="2.3" fill={variant === 'mono' ? 'currentColor' : 'var(--text)'} />
      <circle cx="16" cy="12.5" r="2.3" fill={variant === 'mono' ? 'currentColor' : 'var(--accent)'} />
      <circle cx="21" cy="16.5" r="2.3" fill={variant === 'mono' ? 'currentColor' : 'var(--accent-2)'} />
      <circle cx="27" cy="9" r="1.6" fill={variant === 'mono' ? 'currentColor' : 'var(--accent-2)'} />
    </svg>
  )
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={`inline-flex items-baseline gap-[3px] font-semibold tracking-[-0.02em] ${className ?? ''}`}>
      <span>Open</span>
      <span className="font-normal text-muted">Composer</span>
    </span>
  )
}

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2">
      <LogoMark size={size} />
      <Wordmark className="text-[14px]" />
    </span>
  )
}

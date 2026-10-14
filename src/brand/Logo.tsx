import mark from "./mark.json";

type Variant = "color" | "mono";

/** Three candlesticks share a root: market events, a grove, and an extensible foundation. */
export function LogoMark({
  size = 24,
  variant = "color",
  className,
}: {
  size?: number;
  variant?: Variant;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={mark.viewBox}
      fill="none"
      role="img"
      aria-label="Tickgrove"
      className={className}
      style={variant === "color" ? { color: "var(--brand, var(--accent))" } : undefined}
    >
      <path
        d={mark.stems}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d={mark.bodies} fill="currentColor" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return <span className={`font-semibold tracking-[-0.035em] ${className ?? ""}`}>Tickgrove</span>;
}

export function Logo({ size = 24 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2">
      <LogoMark size={size} />
      <Wordmark className="text-[15px]" />
    </span>
  );
}

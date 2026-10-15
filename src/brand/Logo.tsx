import mark from "./mark.json";

type Variant = "color" | "mono";

/** A modular T with an open, branching counter; one solid silhouette at every size. */
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
      <path d={mark.path} fill="currentColor" />
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

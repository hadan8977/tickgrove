/** Indicator outputs may be prices, ratios or oscillators: retain small nonzero values. */
export function formatIndicatorValue(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  const magnitude = Math.abs(value);
  if (magnitude > 0 && magnitude < 1e-20) return value.toExponential(5);
  const precision = magnitude > 0 && magnitude < 1
    ? Math.min(20, Math.max(2, 5 - Math.floor(Math.log10(magnitude))))
    : 2;
  return (Object.is(value, -0) ? 0 : value).toLocaleString("en-US", {
    minimumFractionDigits: 2, maximumFractionDigits: precision,
  });
}

/** PineTS 0.11.1 exposes these display constants as strings. Keep data-only plots off the price scale. */
export function pinePaneVisible(display: unknown): boolean {
  return !["none", "data_window", "price_scale", "status_line"].includes(String(display));
}

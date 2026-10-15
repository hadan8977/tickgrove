/** Retain hidden charts when reducing a grid; keep its active chart visible. */
export function gridChartOrder(
  visible: string[], retained: string[] | undefined, available: Record<string, unknown>,
  activeId: string | null, count: number,
) {
  const order = [...new Set([...(Array.isArray(retained) ? retained : []), ...visible])]
    .filter((id) => typeof id === "string" && Object.prototype.hasOwnProperty.call(available, id));
  const active = activeId ? order.indexOf(activeId) : -1;
  if (active >= count) order.unshift(...order.splice(active, 1));
  return order;
}

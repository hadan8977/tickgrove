/** Supported event-broker contract. Native backtests keep their richer order engine. */
export function validateBrokerOrder(order: any): void {
  if (!order || typeof order.id !== 'string' || !order.id || order.status !== 'pending') throw Error('Invalid pending broker order identity');
  if (!['market', 'limit', 'stop', 'stop-limit'].includes(order.type)) throw Error('Unsupported broker order type');
  for (const key of ['profit', 'loss', 'trail_price', 'trail_points', 'trail_offset']) {
    if (order[key] != null) throw Error(`Unsupported event broker order field ${key}; use an explicit absolute stop/limit or the native closed-bar engine`);
  }
  if (order.oca_name || order.oca_type && order.oca_type !== 'none') throw Error('Event broker OCA groups require an explicit execution policy');
  if (order.immediately === true) throw Error('Immediate Pine fills are unavailable in the next-quote event broker');
  if (order.category != null && !['entry', 'exit'].includes(order.category)) throw Error('Unsupported broker order category');
  for (const key of ['limit', 'stop']) if (order[key] != null && (!Number.isFinite(order[key]) || order[key] <= 0)) throw Error(`Invalid broker ${key} price`);
  if (order.category === 'exit' && order.limit != null && order.stop != null) throw Error('Two-leg Pine exit requires OCO; it cannot become a stop-limit order');
  if (order.category !== 'exit' && ![1, -1].includes(order.direction)) throw Error('Invalid broker order direction');
  if (!Number.isFinite(order.qty) || order.qty < 0 || order.category !== 'exit' && order.qty <= 0) throw Error('Invalid broker order quantity');
  if (order.qty_percent != null && (!Number.isFinite(order.qty_percent) || order.qty_percent <= 0 || order.qty_percent > 100)) throw Error('Invalid broker exit percentage');
}

import { command } from "./client";
import { useApp } from "../store";
let seen = new Set<string>(),
  initialized = false,
  pending = false,
  strategyAlerts = false;
export function resetNotifications(strategies = false) {
  seen = new Set();
  initialized = false;
  strategyAlerts = strategies;
}
export async function pollNotifications() {
  if (pending) return;
  pending = true;
  try {
    const [prices, strategies] = await Promise.all([
      command<any[]>("alerts.history"),
      strategyAlerts ? command<any[]>("alerts.strategyHistory") : Promise.resolve([]),
    ]);
    const events = [
      ...prices,
      ...strategies.map((event) => ({
        ...event,
        message: event.alert.message,
      })),
    ].sort((a, b) => b.receivedAt - a.receivedAt);
    if (initialized)
      for (const event of events.slice().reverse())
        if (!seen.has(event.id))
          useApp.getState().toast({ title: "Alert triggered", body: event.message });
    seen = new Set(events.map((event) => event.id));
    initialized = true;
  } catch {
  } finally {
    pending = false;
  }
}

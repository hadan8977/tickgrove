import { create } from "zustand";
import { command } from "./client";
export interface AccountState {
  startingCash: number;
  cash: number;
  equity: number;
  unrealizedPnl: number;
  realizedPnl: number;
  totalFees: number;
  positions: {
    symbol: string;
    provider: string;
    qty: number;
    avg: number;
    last: number;
    unrealizedPnl: number;
  }[];
  orders: {
    id: string;
    client_order_id: string;
    provider: string;
    symbol: string;
    feed?: string;
    side: string;
    type: string;
    qty: number;
    price?: number;
    stopPrice?: number;
    status: string;
    createdAt: number;
    source: string;
    error?: string;
  }[];
  fills: {
    id: string;
    orderId: string;
    provider: string;
    symbol: string;
    side: string;
    qty: number;
    price: number;
    time: number;
    fee: number;
    marketCursor: number;
  }[];
  quotePolicy: {
    commissionBps: number;
    maxQuoteAgeMs: number;
    maxGrossLeverage: number;
    currency: string;
    execution: string;
    requiresConnected: boolean;
    pineLedgerImported: boolean;
    executableProviders?: string[];
  };
}
export const useAccount = create<{
  data?: AccountState;
  error?: string;
  updatedAt?: number;
}>(() => ({}));
let pending: Promise<void> | undefined;
export function refreshAccount() {
  if (pending) return pending;
  pending = command<AccountState>("account.state")
    .then((data) => {
      useAccount.setState({ data, error: undefined, updatedAt: Date.now() });
    })
    .catch((error) => {
      useAccount.setState({ error: String(error) });
    })
    .finally(() => {
      pending = undefined;
    });
  return pending;
}
export async function accountAction(method: string, params: Record<string, unknown> = {}) {
  const result = await command(method, params, crypto.randomUUID());
  await refreshAccount();
  return result;
}

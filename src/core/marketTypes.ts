/** Server-owned real market data contract. Event timestamps use Unix milliseconds;
 * OHLCV time/closeTime remain Unix seconds for the Pine/backtest adapter. */
export interface MarketIdentity {
 tickSize?:number;pricePrecision?:number;sizeIncrement?:number;
 symbolId: string; symbol: string; venue: string; currency: string; assetClass: string;
 timeframe: string; timezone: string; session: string; adjustment: string;
 provider: 'coinbase'|'yahoo'|'alpaca'; feed: string; delay: {kind:'realtime'|'delayed'|'unknown';seconds:number|null;disclaimer:string};
}
export interface MarketBar {time:number;closeTime:number;open:number;high:number;low:number;close:number;volume:number|null}
export type MarketEventType = 'quote'|'trade'|'heartbeat'|'bar.update'|'bar.closed'|'bar.revised'|'gap'|'connection'
export interface MarketEvent {
 cursor:number;subscriptionId:string;type:MarketEventType;identity:MarketIdentity;
 eventTime:number;receivedAt:number;payload:Record<string,unknown>;
 quality:{complete:boolean;stale:boolean;reason?:string};
}
export interface MarketSubscription {id:string;identity:MarketIdentity;status:'connecting'|'connected'|'reconnecting'|'stopped';desired:boolean;lastEventAt:number|null;stalenessMs:number|null;error:string|null}
export interface MarketHistoryResult {snapshot_id:string|null;hash:string;bars:number;data:{symbol:string;timeframe:string;metadata:Record<string,unknown>;bars:MarketBar[]};identity:MarketIdentity;gaps:{start:number;end:number}[];provenance:Record<string,unknown>;page?:{hasMore:boolean;nextBefore:number|null;limit:number;requestedStart:number;requestedEnd:number;coverageStart?:number;reason?:string};cache?:{hit:boolean;expiresAt?:number;policy?:string}}

export interface MarketSnapshot {bars:MarketBar[];forming:{bar:MarketBar;quality:Record<string,unknown>}|null;identity:MarketIdentity;quality:Record<string,unknown>[];cursor:number;status:string;error:string|null;lastQuote:Record<string,unknown>|null;quoteQuality:Record<string,unknown>|null}

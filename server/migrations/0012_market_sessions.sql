DROP INDEX market_active_subscription;
CREATE UNIQUE INDEX market_active_subscription ON market_subscriptions(provider,symbol,timeframe,feed,json_extract(identity,'$.session')) WHERE desired=1;

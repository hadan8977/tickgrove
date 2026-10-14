"""Tickgrove standard-library SDK; existing trading.commands.v1 protocol."""
import json
import urllib.request
class TickgroveClient:
    def __init__(self, token, url="http://127.0.0.1:8787"):
        self.token, self.url = token, url.rstrip("/")
    def command(self, method, params=None, idempotency_key=None):
        body = json.dumps({"method":method,"params":params or {},"idempotency_key":idempotency_key}).encode()
        request = urllib.request.Request(self.url+"/api/command", data=body, headers={"Content-Type":"application/json","Authorization":"Bearer "+self.token})
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)

# Backward-compatible class name and original module path.
TradingClient = TickgroveClient

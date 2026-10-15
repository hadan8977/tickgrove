import { useEffect, useState } from "react";
import { Link2, ShieldCheck } from "lucide-react";
import { invalidateProviderConnection } from "../data/feed";
import { command } from "./client";
import { useConnection } from "./workspaceSync";
import { Button, Input, Select } from "../ui/primitives";

type Provider = {
  id: string;
  name: string;
  requiresKey: boolean;
  configured: boolean;
  description: string;
  credentialsSource?: string;
};

export default function DataConnections({ onChoose }: { onChoose: (provider: string) => void }) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const [secret, setSecret] = useState("");
  const [feed, setFeed] = useState("iex");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const canManage = useConnection((s) => s.permissions.includes("connections.manage"));
  const refresh = async () =>
    setProviders((await command<{ providers: Provider[] }>("connections.list")).providers);
  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
  }, []);
  const act = async (name: string, work: () => Promise<void>) => {
    setBusy(name);
    setError("");
    setMessage("");
    try {
      await work();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  };
  const test = (provider: string, supplied = false) =>
    act(provider, async () => {
      const result = await command<{ sampleAvailable: boolean; latencyMs: number }>(
        "connections.test",
        {
          provider,
          ...(provider === "alpaca" ? { feed } : {}),
          ...(supplied ? { apiKey: key, apiSecret: secret } : {}),
        },
      );
      setMessage(
        `${provider}: connection accepted${result.sampleAvailable ? ", sample data received" : ", no current sample"}. ${result.latencyMs} ms. Live stream status appears on the chart.`,
      );
    });
  return (
    <section aria-label="Your data connections" className="my-5 space-y-3">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Link2 size={16} /> Your data connections
      </div>
      <p className="max-w-3xl text-xs leading-relaxed text-muted">
        Tickgrove connects from your own server. Stock history and crypto data work without a key.
        Optional account connections use your own provider access; Tickgrove has no subscription or
        data service.
      </p>
      <div className="grid gap-3 md:grid-cols-3">
        {providers.map((provider) => (
          <article
            key={provider.id}
            className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-4"
          >
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">{provider.name}</h3>
              <span className="shrink-0 text-[11px] text-muted">
                {provider.requiresKey
                  ? provider.configured
                    ? "Configured"
                    : "Optional"
                  : "No key"}
              </span>
            </div>
            <p className="flex-1 text-xs leading-relaxed text-muted">{provider.description}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() =>
                  provider.requiresKey && !provider.configured
                    ? setEditing(true)
                    : onChoose(provider.id)
                }
              >
                {provider.requiresKey && !provider.configured ? "Connect account" : "Use source"}
              </Button>
              {canManage && (
                <Button
                  size="sm"
                  disabled={!!busy || (provider.requiresKey && !provider.configured)}
                  onClick={() => void test(provider.id)}
                >
                  {busy === provider.id ? "Checking…" : "Test"}
                </Button>
              )}
              {provider.requiresKey && canManage && provider.configured && (
                <Button size="sm" onClick={() => setEditing(!editing)}>
                  Manage
                </Button>
              )}
            </div>
          </article>
        ))}
      </div>
      {editing && (
        <form
          className="max-w-2xl space-y-3 rounded-xl border border-line bg-panel-2 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void act("save", async () => {
              await command("connections.save", {
                provider: "alpaca",
                apiKey: key,
                apiSecret: secret,
              });
              invalidateProviderConnection("alpaca");
              setKey("");
              setSecret("");
              setEditing(false);
              await refresh();
              setMessage(
                "Alpaca settings saved. Test the connection, then reopen Alpaca charts. Existing source-bound strategies stay on their original source and need review.",
              );
            });
          }}
        >
          <div className="flex items-center gap-2 text-sm font-semibold">
            <ShieldCheck size={16} /> Connect your Alpaca account
          </div>
          <p className="text-xs leading-relaxed text-muted">
            Use keys dedicated to this instance. Free IEX data is available with eligible accounts;
            other feeds depend on your provider plan. Orders use the Paper endpoint only.
          </p>
          {!canManage && (
            <p className="text-xs text-demo">
              This token cannot change connection settings. Use an owner token to configure an
              account.
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs">
              API key
              <Input
                aria-label="Alpaca API key"
                autoComplete="off"
                className="mt-1 w-full"
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
            </label>
            <label className="text-xs">
              API secret
              <Input
                aria-label="Alpaca API secret"
                autoComplete="new-password"
                className="mt-1 w-full"
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
              />
            </label>
          </div>
          <label className="block text-xs">
            Test feed
            <Select className="ml-2" value={feed} onChange={(e) => setFeed(e.target.value)}>
              <option value="iex">IEX · free account coverage</option>
              <option value="sip">SIP · account permission required</option>
              <option value="boats">BOATS · overnight permission</option>
              <option value="overnight">Overnight · indicative / delayed</option>
            </Select>
          </label>
          <p className="text-xs leading-relaxed text-muted">
            Credentials stay in a private server file, outside workspace exports, and are never
            returned to the browser. Use HTTPS for remote access.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              variant="primary"
              disabled={!canManage || !!busy || !key.trim() || !secret.trim()}
            >
              {busy === "save" ? "Saving…" : "Save connection"}
            </Button>
            <Button
              type="button"
              disabled={!canManage || !!busy || !key.trim() || !secret.trim()}
              onClick={() => void test("alpaca", true)}
            >
              Test these keys
            </Button>
            <Button
              type="button"
              onClick={() => {
                setEditing(false);
                setKey("");
                setSecret("");
              }}
            >
              Cancel
            </Button>
            {providers.some(
              (p) => p.id === "alpaca" && p.credentialsSource === "server-private-file",
            ) && (
              <Button
                type="button"
                disabled={!canManage || !!busy}
                onClick={() =>
                  void act("remove", async () => {
                    await command("connections.remove", { provider: "alpaca" });
                    invalidateProviderConnection("alpaca");
                    await refresh();
                    setEditing(false);
                    setMessage(
                      "Saved keys removed. Credentials configured through the server environment, if present, remain available.",
                    );
                  })
                }
              >
                Remove saved keys
              </Button>
            )}
          </div>
        </form>
      )}
      {message && (
        <p role="status" className="text-xs text-up">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="break-words text-xs text-down">
          {error}
        </p>
      )}
    </section>
  );
}

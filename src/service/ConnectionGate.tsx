import { useEffect, useState } from "react";
import { connectService, useConnection } from "./workspaceSync";
import { getServiceToken } from "./client";
import { Button, Input } from "../ui/primitives";
import { Logo } from "../brand/Logo";
export default function ConnectionGate() {
  const state = useConnection(),
    [token, setToken] = useState(getServiceToken());
  useEffect(() => {
    if (getServiceToken()) void connectService(getServiceToken()).catch(() => {});
  }, []);
  return (
    <div className="grid h-full place-items-center bg-bg p-5">
      <form
        className="w-full max-w-md rounded-2xl border border-line bg-panel p-7"
        onSubmit={(e) => {
          e.preventDefault();
          void connectService(token).catch(() => {});
        }}
      >
        <Logo />
        <h1 className="mb-2 mt-6 text-xl font-semibold">Connect to your trading workspace</h1>
        <p className="mb-5 text-sm text-muted">
          Charts use the market data providers configured on this instance. Layouts, strategies,
          runs and simulated accounts are saved by the server.
        </p>
        <label className="mb-2 block text-sm">Instance token</label>
        <Input
          type="password"
          autoComplete="current-password"
          placeholder="Instance token (var/auth-token)"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <Button
          type="submit"
          variant="primary"
          className="mt-4 w-full"
          disabled={state.connecting || !token}
        >
          {state.connecting ? "Connecting…" : "Connect"}
        </Button>
        {state.error && (
          <p role="alert" className="mt-3 text-sm text-down">
            {state.error}
          </p>
        )}
        <p className="mt-5 text-xs text-muted">
          The token is generated when the service first starts. Market data credentials stay on the
          server.
        </p>
        <a className="mt-4 block text-xs text-muted underline" href="?mode=demo">
          Open the separate synthetic demo
        </a>
      </form>
    </div>
  );
}

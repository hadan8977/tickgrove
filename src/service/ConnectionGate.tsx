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
        <h1 className="mb-2 mt-6 text-xl font-semibold">Connect to Tickgrove</h1>
        <p className="mb-5 text-sm text-muted">
          Your self-hosted workspace. Free stock history and crypto connections are ready without a
          data key. Your layouts, scripts and simulated accounts stay on this server.
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
        <details className="mt-3 text-xs text-muted">
          <summary className="cursor-pointer">Where do I find the instance token?</summary>
          <p className="mt-2">
            On the server, read <code>var/auth-token</code>. For Docker:
          </p>
          <code className="mt-2 block overflow-auto rounded bg-panel-2 p-2">
            docker compose exec trading cat /app/var/auth-token
          </code>
          <p className="mt-2">
            For Paseo preview, use <code>var/paseo-preview/auth-token</code>. This token protects
            your workspace; it is separate from any data provider key.
          </p>
        </details>
        <a className="mt-4 block text-xs text-muted underline" href="?mode=demo">
          Open the separate synthetic demo
        </a>
      </form>
    </div>
  );
}

let token =
  typeof sessionStorage === "undefined" ? "" : (sessionStorage.getItem("trading.token") ?? "");
export function getServiceToken() {
  return token;
}
export function setServiceToken(value: string) {
  token = value;
  if (typeof sessionStorage !== "undefined") sessionStorage.setItem("trading.token", value);
}
export async function command<T = any>(
  method: string,
  params: unknown = {},
  key?: string,
): Promise<T> {
  const response = await fetch("/api/command", {
    signal: AbortSignal.timeout(120000),
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ method, params, idempotency_key: key }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? response.statusText);
  return body;
}

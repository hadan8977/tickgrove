import { compatibleStorage } from "../brand/storage";
let token =
  typeof sessionStorage === "undefined"
    ? ""
    : (compatibleStorage(sessionStorage, "trading.").getItem("tickgrove.token") ?? "");
export function getServiceToken() {
  return token;
}
export function setServiceToken(value: string) {
  token = value;
  if (typeof sessionStorage !== "undefined")
    compatibleStorage(sessionStorage, "trading.").setItem("tickgrove.token", value);
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
  let body: any;
  try {
    body = await response.json();
  } catch {
    throw new Error(response.ok
      ? "The trading service returned an incomplete response. Please retry."
      : `The trading service is unavailable (HTTP ${response.status}). Check the server connection and retry.`);
  }
  if (!response.ok) throw new Error(body.error ?? response.statusText);
  return body;
}

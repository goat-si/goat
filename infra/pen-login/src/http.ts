// Small helpers shared by the Worker and the Durable Object.

export const SOURCE_HEADER = "x-pen-source";
export const COUNTRY_HEADER = "x-pen-country";
export const CITY_HEADER = "x-pen-city";
export const TRUSTED_HEADERS = [SOURCE_HEADER, COUNTRY_HEADER, CITY_HEADER] as const;

/** Rate-limit key for an address: IPv4 as is, IPv6 by its /64. */
export function sourceKey(address: string | null): string {
  if (!address) return "unknown";
  if (!address.includes(":")) return address;
  const [head = "", tail = ""] = address.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = address.includes("::")
    ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
    : left;
  return (
    groups
      .slice(0, 4)
      .map((group) => (Number.parseInt(group || "0", 16) || 0).toString(16))
      .join(":") + "::/64"
  );
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

const MAX_BODY = 8192;

/** The request body as text, or null when it is larger than 8 KiB; reading stops at the limit. */
export async function readBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const text = await readBody(request);
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function readForm(request: Request): Promise<URLSearchParams | null> {
  const text = await readBody(request);
  return text === null ? null : new URLSearchParams(text);
}

/** Equal-length comparison that does not stop at the first difference. */
export function sameText(a: string, b: string): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

export function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

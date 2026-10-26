// @effect-diagnostics globalDate:off - A plain Cloudflare Worker with no Effect runtime.
import { MAX_BODY_BYTES, parseBatch } from "./batch.ts";
import {
  deleteExpired,
  insertBatch,
  rowStorageCost,
  utcDay,
  type IngestDatabase,
} from "./store.ts";

export interface IngestEnv<Statement> {
  readonly DB: IngestDatabase<Statement>;
  readonly RATE_LIMITER: {
    limit(options: { key: string }): Promise<{ readonly success: boolean }>;
  };
  readonly ACCEPTED_KEYS: string;
  readonly RETENTION_DAYS: string;
  readonly DAILY_BATCH_BUDGET: string;
  readonly DAILY_BYTE_BUDGET: string;
}

interface IngestConfig {
  readonly acceptedKeys: ReadonlySet<string>;
  readonly retentionDays: number;
  readonly budget: { readonly batches: number; readonly bytes: number };
}

const positiveInteger = (value: string): number | undefined => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
};

/** A misconfigured deploy refuses everything (503, retried) instead of storing unbounded. */
function readConfig<Statement>(env: IngestEnv<Statement>): IngestConfig | undefined {
  const acceptedKeys = new Set(
    env.ACCEPTED_KEYS.split(",")
      .map((key) => key.trim())
      .filter((key) => key !== ""),
  );
  const retentionDays = positiveInteger(env.RETENTION_DAYS);
  const batches = positiveInteger(env.DAILY_BATCH_BUDGET);
  const bytes = positiveInteger(env.DAILY_BYTE_BUDGET);
  if (acceptedKeys.size === 0 || retentionDays === undefined || retentionDays < 2) return undefined;
  if (batches === undefined || bytes === undefined) return undefined;
  return { acceptedKeys, retentionDays, budget: { batches, bytes } };
}

const empty = (status: number, headers?: HeadersInit) =>
  new Response(null, headers === undefined ? { status } : { status, headers });

/**
 * Reads at most MAX_BODY_BYTES. A declared length over the cap is refused unread; an
 * absent or wrong one is caught while streaming, and the stream is cancelled.
 */
async function readBody(request: Request): Promise<string | 400 | 413> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return 413;
  if (request.body === null) return 400;
  const reader = request.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return 413;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return 400;
  }
}

const sha256Hex = async (text: string): Promise<string> =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

/**
 * Accepts the PostHog `/batch/` body the GOAT server sends. Nothing about the request
 * is logged or stored except the sanitized events and the UTC day they arrived; the
 * client address is used only as the rate limiter's key.
 */
export async function handleRequest<Statement>(
  request: Request,
  env: IngestEnv<Statement>,
  now: Date,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname !== "/batch" && pathname !== "/batch/") return empty(404);
  if (request.method !== "POST") return empty(405, { allow: "POST" });

  const config = readConfig(env);
  if (config === undefined) return empty(503);

  // Cloudflare sets CF-Connecting-IP; a client cannot override it. X-Forwarded-For can be forged.
  const limited = await env.RATE_LIMITER.limit({
    key: request.headers.get("cf-connecting-ip") ?? "unknown",
  }).then(
    (outcome) => !outcome.success,
    () => undefined,
  );
  if (limited === undefined) return empty(503);
  if (limited) return empty(429);

  const body = await readBody(request);
  if (typeof body === "number") return empty(body);
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return empty(400);
  }
  const parsed = parseBatch(json, config.acceptedKeys);
  if (!parsed.ok) return empty(parsed.status);

  const stored = JSON.stringify(parsed.batch);
  const outcome = await insertBatch(
    env.DB,
    {
      day: utcDay(now),
      batchId: await sha256Hex(stored),
      eventCount: parsed.eventCount,
      json: stored,
      cost: rowStorageCost(new TextEncoder().encode(stored).byteLength),
    },
    config.budget,
  ).catch(() => undefined);
  // A D1 failure (daily write limit, size limit, overload) and a spent budget are
  // retried by the server later, so both answer 503.
  if (outcome === undefined || outcome === "over_budget") return empty(503);
  return Response.json({ status: 1 });
}

export async function runRetention<Statement>(env: IngestEnv<Statement>, now: Date) {
  const config = readConfig(env);
  if (config !== undefined) await deleteExpired(env.DB, now, config.retentionDays);
}

type Env = IngestEnv<D1PreparedStatement>;

export default {
  fetch: (request, env) => handleRequest(request, env, new Date()),
  scheduled: (controller, env, context) => {
    context.waitUntil(runRetention(env, new Date(controller.scheduledTime)));
  },
} satisfies ExportedHandler<Env>;

import { isNodeId, nodeIdFromSignPub, sha256 } from "@goat/pen-protocol/identity";
import {
  type Assertion,
  assertionHash,
  base64url,
  checkAssertion,
  forgetProofMessage,
  fromBase64url,
  pollProofMessage,
  signAssertion,
  startProofMessage,
} from "@goat/pen-protocol/login";
import { type Context, deviceTtl, limited, POLL_INTERVAL_S } from "./context.ts";
import { json, readJson } from "./http.ts";
import { Caps, type DeviceRow } from "./store.ts";

const NAME = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const MESH_ID = /^[a-z2-7]{26}$/;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A canonical base64url string of exactly length bytes, or null. */
function bytesOf(value: unknown, length: number): Uint8Array<ArrayBuffer> | null {
  if (typeof value !== "string") return null;
  try {
    const bytes = fromBase64url(value);
    return bytes.length === length ? bytes : null;
  } catch {
    return null;
  }
}

async function verifyEd25519(
  pub: Uint8Array<ArrayBuffer>,
  sig: Uint8Array<ArrayBuffer>,
  message: Uint8Array<ArrayBuffer>,
) {
  try {
    const key = await crypto.subtle.importKey("raw", pub, "Ed25519", false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, sig, message);
  } catch {
    return false;
  }
}

export async function codeHash(deviceCode: Uint8Array): Promise<string> {
  return base64url(await sha256(deviceCode));
}

function newUserCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (byte) => CROCKFORD[byte & 31]).join("");
}

/** XXXX-XXXX for people; stored without the dash. */
export function formatUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Accepts the code as people type it: any case, dashes or spaces, O for 0, I or L for 1. */
export function normalizeUserCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return code.length === 8 && [...code].every((char) => CROCKFORD.includes(char)) ? code : null;
}

export async function keys(ctx: Context): Promise<Response> {
  return json({ keys: [(await ctx.loginKey()).public] });
}

export async function start(ctx: Context, request: Request): Promise<Response> {
  if (limited(ctx, "start")) return json({ error: "rate_limited" }, 429);
  const body = await readJson(request);
  const signPub = bytesOf(body?.signPub, 32);
  const noisePub = bytesOf(body?.noisePub, 32);
  const proof = bytesOf(body?.proof, 64);
  const name = body?.name;
  if (!signPub || !noisePub || !proof || typeof name !== "string" || !NAME.test(name)) {
    return json({ error: "bad_request" }, 400);
  }
  if (!(await verifyEd25519(signPub, proof, startProofMessage(signPub, noisePub, name)))) {
    return json({ error: "bad_proof" }, 400);
  }
  if (ctx.store.pendingDevices(ctx.now) >= Caps.DEVICES) return json({ error: "busy" }, 503);
  const deviceCode = crypto.getRandomValues(new Uint8Array(32));
  const ttl = deviceTtl(ctx.env);
  const row = {
    code_hash: await codeHash(deviceCode),
    sign_pub: base64url(signPub),
    noise_pub: base64url(noisePub),
    name,
    country: ctx.country,
    city: ctx.city,
    created_at: ctx.now,
    expires_at: ctx.now + ttl,
  };
  for (let attempt = 0; attempt < 5; attempt++) {
    const userCode = newUserCode();
    if (ctx.store.insertDevice({ ...row, user_code: userCode })) {
      return json({
        deviceCode: base64url(deviceCode),
        userCode: formatUserCode(userCode),
        verificationUri: `${ctx.origin}/device`,
        interval: POLL_INTERVAL_S,
        expiresIn: Math.floor(ttl / 1000),
      });
    }
  }
  return json({ error: "busy" }, 503);
}

function meshFor(ctx: Context, sub: string) {
  const meshId = ctx.store.meshOf(sub);
  if (meshId === null) return null;
  const members = ctx.store.nodesOf(sub).map((node) => ({
    nodeId: node.node_id,
    signPub: node.sign_pub,
    noisePub: node.noise_pub,
    name: node.name,
  }));
  return { meshId, members };
}

async function mint(
  ctx: Context,
  device: DeviceRow,
  sub: string,
  email: string,
): Promise<Response> {
  const signer = await ctx.loginKey();
  const iat = Math.floor(ctx.now / 1000);
  const assertion = await signAssertion(
    {
      v: 1,
      iss: ctx.origin,
      kid: signer.public.kid,
      sub,
      email,
      signPub: device.sign_pub,
      noisePub: device.noise_pub,
      iat,
      exp: iat + 600,
    },
    signer.key,
  );
  ctx.store.insertAssertion(await assertionHash(assertion), sub, device.name, iat + 600);
  return json({
    assertion,
    account: { sub, email },
    loginKey: signer.public,
    mesh: meshFor(ctx, sub),
  });
}

export async function token(ctx: Context, request: Request): Promise<Response> {
  const body = await readJson(request);
  const deviceCode = bytesOf(body?.deviceCode, 32);
  const proof = bytesOf(body?.proof, 64);
  if (!deviceCode || !proof) return json({ status: "invalid" }, 400);
  const hash = await codeHash(deviceCode);
  const device = ctx.store.deviceByHash(hash);
  if (!device) return json({ status: "expired" }, 410);
  if (!(await verifyEd25519(fromBase64url(device.sign_pub), proof, pollProofMessage(deviceCode)))) {
    return json({ status: "invalid" }, 400);
  }
  if (device.status === "consumed" || ctx.now >= device.expires_at)
    return json({ status: "expired" }, 410);
  if (device.last_poll_at !== 0 && ctx.now - device.last_poll_at < POLL_INTERVAL_S * 1000) {
    return json({ status: "slow_down" }, 429);
  }
  ctx.store.setPolled(hash, ctx.now);
  if (device.status === "denied") return json({ status: "denied" }, 403);
  if (device.status === "pending" || !device.sub || !device.email)
    return json({ status: "pending" }, 428);
  if (!ctx.store.consume(hash)) return json({ status: "expired" }, 410);
  return mint(ctx, device, device.sub, device.email);
}

function assertionOf(value: unknown): Assertion | null {
  if (typeof value !== "object" || value === null) return null;
  const { body, sig } = value as Record<string, unknown>;
  return typeof body === "string" && typeof sig === "string" ? { body, sig } : null;
}

export async function register(ctx: Context, request: Request): Promise<Response> {
  if (limited(ctx, "registry")) return json({ error: "rate_limited" }, 429);
  const body = await readJson(request);
  const assertion = assertionOf(body?.assertion);
  const meshId = body?.meshId;
  if (!assertion || typeof meshId !== "string" || !MESH_ID.test(meshId))
    return json({ error: "bad_request" }, 400);
  const signer = await ctx.loginKey();
  const checked = await checkAssertion(assertion, {
    keys: [signer.public],
    iss: ctx.origin,
    now: Math.floor(ctx.now / 1000),
    skew: 0,
  });
  if (!checked.ok) return json({ error: checked.reason }, 400);
  const hash = await assertionHash(assertion);
  const issued = ctx.store.assertion(hash);
  if (!issued) return json({ error: "unknown_assertion" }, 400);
  if (issued.used) return json({ error: "assertion_used" }, 409);
  const current = ctx.store.meshOf(checked.body.sub);
  if (current !== null && current !== meshId)
    return json({ error: "mesh_mismatch", meshId: current }, 409);
  if (!ctx.store.markAssertionUsed(hash)) return json({ error: "assertion_used" }, 409);
  ctx.store.bindMesh(checked.body.sub, meshId, ctx.now);
  ctx.store.upsertNode(
    {
      node_id: await nodeIdFromSignPub(fromBase64url(checked.body.signPub)),
      sub: checked.body.sub,
      sign_pub: checked.body.signPub,
      noise_pub: checked.body.noisePub,
      name: issued.name,
    },
    ctx.now,
  );
  return json({ ok: true, meshId });
}

export async function forget(ctx: Context, request: Request): Promise<Response> {
  if (limited(ctx, "registry")) return json({ error: "rate_limited" }, 429);
  const body = await readJson(request);
  const nodeId = body?.nodeId;
  const by = bytesOf(body?.by, 32);
  const proof = bytesOf(body?.proof, 64);
  const ts = body?.ts;
  if (
    typeof nodeId !== "string" ||
    !isNodeId(nodeId) ||
    !by ||
    !proof ||
    typeof ts !== "number" ||
    !Number.isSafeInteger(ts) ||
    ts < 0
  ) {
    return json({ error: "bad_request" }, 400);
  }
  if (Math.abs(ctx.now - ts) > 120_000) return json({ error: "stale" }, 400);
  if (!(await verifyEd25519(by, proof, forgetProofMessage(nodeId, ts))))
    return json({ error: "bad_proof" }, 400);
  const target = ctx.store.node(nodeId);
  if (!target) return json({ ok: true, removed: false });
  const self = (await nodeIdFromSignPub(by)) === nodeId;
  const sibling = ctx.store.nodeBySignPub(base64url(by))?.sub === target.sub;
  if (!self && !sibling) return json({ error: "forbidden" }, 403);
  ctx.store.deleteNode(nodeId);
  return json({ ok: true, removed: true });
}

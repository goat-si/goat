// @effect-diagnostics globalFetch:off globalDate:off - The service is a plain Worker; tests call it over HTTP.
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { fingerprint, nodeIdFromSignPub } from "@goat/pen-protocol/identity";
import {
  type Assertion,
  base64url,
  checkAssertion,
  forgetProofMessage,
  fromBase64url,
  type LoginKey,
  registerProofMessage,
} from "@goat/pen-protocol/login";
import { type FakeIssuer, type IdTokenOverrides, rsaKey, startFakeIssuer } from "./fakeIssuer.ts";
import {
  api,
  Browser,
  type Device,
  device,
  freshSource,
  poll,
  type Service,
  startDevice,
  startService,
} from "./harness.ts";

const LOGIN_SEED = base64url(new Uint8Array(32).fill(0x4c));
const USER_CODE = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
const MESH_A = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const MESH_B = "bbbbbbbbbbbbbbbbbbbbbbbbbb";

async function boot(extra: Record<string, string> = {}) {
  const issuer = await startFakeIssuer();
  const service = await startService({
    GOOGLE_CLIENT_ID: issuer.clientId,
    GOOGLE_CLIENT_SECRET: issuer.clientSecret,
    LOGIN_SIGNING_KEY: LOGIN_SEED,
    GOOGLE_DISCOVERY: issuer.discovery,
    GOOGLE_ISSUER: issuer.url,
    ...extra,
  });
  return { issuer, service };
}

interface SignIn {
  readonly machine: Device;
  readonly deviceCode: string;
  readonly userCode: string;
  readonly browser: Browser;
  /** The page the Google callback answered with. */
  readonly callback: Awaited<ReturnType<Browser["get"]>>;
  readonly callbackUrl: string;
}

/** Starts a device and walks a browser through code entry and the Google round trip. */
async function signIn(
  service: Service,
  issuer: FakeIssuer,
  overrides: IdTokenOverrides = {},
  name = "box-1",
): Promise<SignIn> {
  const machine = await device(name);
  const started = await startDevice(service.url, machine);
  expect(started.status).toBe(200);
  const deviceCode = String(started.json.deviceCode);
  const userCode = String(started.json.userCode);
  const browser = new Browser(service.url);
  const entry = await browser.get("/device");
  expect(entry.status).toBe(200);
  const sent = await browser.post("/device", { code: userCode, csrf: entry.csrf ?? "" });
  expect(sent.status).toBe(303);
  expect(sent.location?.startsWith(`${issuer.url}/authorize?`)).toBe(true);
  issuer.next = overrides;
  const google = await fetch(sent.location ?? "", { redirect: "manual" });
  expect(google.status).toBe(302);
  const callbackUrl = google.headers.get("location") ?? "";
  const callback = await browser.get(callbackUrl);
  return { machine, deviceCode, userCode, browser, callback, callbackUrl };
}

async function approved(
  service: Service,
  issuer: FakeIssuer,
  overrides: IdTokenOverrides = {},
  name = "box-1",
) {
  const flow = await signIn(service, issuer, overrides, name);
  expect(flow.callback.status).toBe(200);
  const done = await flow.browser.post("/device/confirm", {
    csrf: flow.callback.csrf ?? "",
    action: "approve",
  });
  expect(done.status).toBe(200);
  const token = await poll(service.url, flow.machine, flow.deviceCode);
  expect(token.status).toBe(200);
  return { ...flow, token: token.json };
}

async function keys(service: Service): Promise<Array<LoginKey>> {
  const response = await fetch(`${service.url}/v1/keys`);
  return ((await response.json()) as { keys: Array<LoginKey> }).keys;
}

interface Minted {
  readonly machine: Device;
  readonly token: Record<string, unknown>;
}

/** Registers a minted assertion; proof null leaves the proof out, signer signs it with another key. */
async function register(
  service: Service,
  flow: Minted,
  meshId: string,
  options: { signer?: Device; proof?: null } = {},
) {
  const assertion = flow.token.assertion as Assertion;
  const message = await registerProofMessage(fromBase64url(assertion.body), meshId);
  const signer = options.signer ?? flow.machine;
  const body: Record<string, unknown> = { assertion, meshId };
  if (options.proof !== null) body.proof = base64url(await signer.sign(message));
  return api(service.url, "/v1/mesh/register", body);
}

/** Walks the reset pages for sub and confirms. */
async function resetAccount(service: Service, issuer: FakeIssuer, sub: string) {
  const browser = new Browser(service.url);
  const page = await browser.get("/reset");
  const sent = await browser.post("/reset", { csrf: page.csrf ?? "" });
  expect(sent.status).toBe(303);
  issuer.next = { sub };
  const google = await fetch(sent.location ?? "", { redirect: "manual" });
  const confirm = await browser.get(google.headers.get("location") ?? "");
  expect(confirm.status).toBe(200);
  const done = await browser.post("/reset/confirm", { csrf: confirm.csrf ?? "" });
  expect(done.status).toBe(200);
}

/** The service's clock as of a token it answered: the minted assertion's iat. */
function serviceSeconds(token: Record<string, unknown>): number {
  const assertion = token.assertion as Assertion;
  return (JSON.parse(new TextDecoder().decode(fromBase64url(assertion.body))) as { iat: number })
    .iat;
}

async function forget(service: Service, nodeId: string, by: Device, ts: number) {
  const proof = await by.sign(forgetProofMessage(nodeId, ts));
  return api(service.url, "/v1/mesh/forget", {
    nodeId,
    by: by.signPub,
    ts,
    proof: base64url(proof),
  });
}

describe("pen-login contract (Accounts v1.1)", () => {
  let issuer: FakeIssuer;
  let service: Service;
  beforeAll(async () => {
    ({ issuer, service } = await boot());
  });
  afterAll(async () => {
    await service?.stop();
    await issuer?.close();
  });

  it("device start answers a 32-byte device code, an XXXX-XXXX Crockford user code, interval 2 and 600 s; bad proofs and names are 400", async () => {
    const machine = await device();
    const started = await startDevice(service.url, machine);
    expect(started.status).toBe(200);
    expect(fromBase64url(String(started.json.deviceCode)).length).toBe(32);
    expect(String(started.json.userCode)).toMatch(USER_CODE);
    expect(started.json).toMatchObject({
      verificationUri: `${service.url}/device`,
      interval: 2,
      expiresIn: 600,
    });
    const forged = await api(service.url, "/v1/device/start", {
      signPub: machine.signPub,
      noisePub: machine.noisePub,
      name: "box-2",
      proof: base64url(new Uint8Array(64)),
    });
    expect(forged.status).toBe(400);
    const badName = await startDevice(service.url, await device("-bad name"));
    expect(badName.status).toBe(400);
  });

  it("the full device flow approves the machine once, and its assertion verifies under /v1/keys for the signed-in sub", async () => {
    const flow = await signIn(service, issuer);
    expect(flow.callback.status).toBe(200);
    const done = await flow.browser.post("/device/confirm", {
      csrf: flow.callback.csrf ?? "",
      action: "approve",
    });
    expect(done.status).toBe(200);
    const token = await poll(service.url, flow.machine, flow.deviceCode);
    expect(token.status).toBe(200);
    expect(token.json).toMatchObject({
      account: { sub: "100000000000000000001", email: "person@example.com" },
      mesh: null,
    });
    const loginKeys = await keys(service);
    expect(token.json.loginKey).toEqual(loginKeys[0]);
    const result = await checkAssertion(token.json.assertion as Assertion, {
      keys: loginKeys,
      iss: service.url,
      now: serviceSeconds(token.json),
      skew: 0,
      sub: "100000000000000000001",
      signPub: flow.machine.signPub,
      noisePub: flow.machine.noisePub,
    });
    expect(result.ok).toBe(true);
    const again = await poll(service.url, flow.machine, flow.deviceCode);
    expect(again.status).not.toBe(200);
  });

  it("after approval the page confirms the sign-in only and says a locked mesh still needs pen approve", async () => {
    // The service cannot see a mesh's lock state, so the page must not claim the machine joined.
    const flow = await signIn(service, issuer);
    const done = await flow.browser.post("/device/confirm", {
      csrf: flow.callback.csrf ?? "",
      action: "approve",
    });
    expect(done.status).toBe(200);
    expect(done.body).toContain("Sign-in confirmed");
    expect(done.body).toContain("pen approve");
    expect(done.body).not.toContain("Machine added");
  });

  it("the confirm page repeats the code, machine name, fingerprint, place and time with the full-access warning", async () => {
    const flow = await signIn(service, issuer, {}, "studio");
    const page = flow.callback.body;
    expect(page).toContain(flow.userCode);
    expect(page).toContain("studio");
    expect(page).toContain(await fingerprint(fromBase64url(flow.machine.noisePub)));
    expect(page).toContain("person@example.com");
    expect(page).toMatch(/full access/i);
    expect(page).toContain("모든");
    expect(page).toMatch(/data-row="place"/);
    expect(page).toMatch(/data-row="time"/);
  });

  it("pages carry a strict CSP without scripts, no-store, and a __Host- session cookie", async () => {
    const page = await new Browser(service.url).get("/device");
    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toMatch(/style-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(csp).not.toContain("script-src");
    expect(page.body).not.toMatch(/<script/i);
    expect(page.headers.get("cache-control")).toContain("no-store");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    const cookie =
      page.headers.getSetCookie().find((value) => value.startsWith("__Host-pen=")) ?? "";
    for (const flag of ["Secure", "HttpOnly", "SameSite=Lax", "Path=/"])
      expect(cookie).toContain(flag);
    expect(cookie).not.toContain("Domain=");
  });

  it("polling faster than the interval answers 429 slow_down; a bad poll proof is 400", async () => {
    const machine = await device();
    const started = await startDevice(service.url, machine);
    const code = String(started.json.deviceCode);
    expect(await poll(service.url, machine, code)).toEqual({
      status: 428,
      json: { status: "pending" },
    });
    expect(await poll(service.url, machine, code)).toEqual({
      status: 429,
      json: { status: "slow_down" },
    });
    const other = await device();
    expect((await poll(service.url, other, code)).status).toBe(400);
  });

  it.each<[string, IdTokenOverrides]>([
    ["wrong aud", { aud: "someone-else" }],
    ["wrong iss", { iss: "https://evil.example" }],
    ["expired", { expIn: -10 }],
    ["bad signature", { signer: { ...rsaKey("key-a") } }],
    ["nonce mismatch", { nonce: "replayed" }],
    ["email_verified false", { email_verified: false }],
    ["state mismatch", { state: "forged-state" }],
  ])(
    "an id_token or callback with %s shows the error page and approves nothing",
    async (_label, overrides) => {
      const flow = await signIn(service, issuer, overrides);
      expect(flow.callback.status).toBe(400);
      expect(flow.callback.csrf).toBeNull();
      expect(flow.callback.body).toMatch(/start again|다시/i);
      const confirm = await flow.browser.post("/device/confirm", {
        csrf: "anything",
        action: "approve",
      });
      expect(confirm.status).toBe(403);
      expect((await poll(service.url, flow.machine, flow.deviceCode)).status).toBe(428);
    },
  );

  it("a confirm without the page's CSRF token is refused 403 and approves nothing", async () => {
    const flow = await signIn(service, issuer);
    expect(flow.callback.status).toBe(200);
    expect((await flow.browser.post("/device/confirm", { action: "approve" })).status).toBe(403);
    expect(
      (await flow.browser.post("/device/confirm", { csrf: "x".repeat(43), action: "approve" }))
        .status,
    ).toBe(403);
    expect((await poll(service.url, flow.machine, flow.deviceCode)).status).toBe(428);
  });

  it("denying shows the denied page and the device's poll answers 403 denied", async () => {
    const flow = await signIn(service, issuer);
    const denied = await flow.browser.post("/device/confirm", {
      csrf: flow.callback.csrf ?? "",
      action: "deny",
    });
    expect(denied.status).toBe(200);
    expect(denied.body).toMatch(/denied|거부/i);
    expect(await poll(service.url, flow.machine, flow.deviceCode)).toEqual({
      status: 403,
      json: { status: "denied" },
    });
  });

  it("five wrong codes from one source lock it, so even the right code is refused 429", async () => {
    const machine = await device();
    const started = await startDevice(service.url, machine);
    const browser = new Browser(service.url);
    for (let i = 0; i < 5; i++) {
      const entry = await browser.get("/device");
      const wrong = await browser.post("/device", { code: "ZZZZ-ZZZZ", csrf: entry.csrf ?? "" });
      expect(wrong.status).toBe(400);
    }
    const entry = await browser.get("/device");
    const locked = await browser.post("/device", {
      code: String(started.json.userCode),
      csrf: entry.csrf ?? "",
    });
    expect(locked.status).toBe(429);
    expect(locked.location).toBeNull();
  });

  it("an unknown kid does not refetch the JWKS within 5 minutes of the last fetch", async () => {
    await approved(service, issuer);
    const fetches = issuer.jwksFetches;
    const rotated = rsaKey("key-b");
    expect((await signIn(service, issuer, { signer: rotated })).callback.status).toBe(400);
    issuer.published.push(rotated);
    expect((await signIn(service, issuer, { signer: rotated })).callback.status).toBe(400);
    expect(issuer.jwksFetches - fetches).toBe(0);
    issuer.published.pop();
  });

  it("a register without a proof, or with a proof by another key, is refused 400 and leaves the assertion usable", async () => {
    const minted = await approved(service, issuer, { sub: "500000000000000000005" });
    expect((await register(service, minted, MESH_A, { proof: null })).status).toBe(400);
    expect((await register(service, minted, MESH_A, { signer: await device() })).status).toBe(400);
    expect((await register(service, minted, MESH_A)).status).toBe(200);
  });

  it("a reset denies an approved device code kept unpolled and refuses an assertion kept unregistered", async () => {
    const sub = "600000000000000000006";
    const victim = await approved(service, issuer, { sub }, "victim");
    expect((await register(service, victim, MESH_A)).status).toBe(200);
    const keptCode = await signIn(service, issuer, { sub }, "kept-code");
    const approve = await keptCode.browser.post("/device/confirm", {
      csrf: keptCode.callback.csrf ?? "",
      action: "approve",
    });
    expect(approve.status).toBe(200);
    const keptAssertion = await approved(service, issuer, { sub }, "kept-assertion");

    await resetAccount(service, issuer, sub);

    expect(await poll(service.url, keptCode.machine, keptCode.deviceCode)).toEqual({
      status: 403,
      json: { status: "denied" },
    });
    expect((await register(service, keptAssertion, MESH_B)).status).toBe(409);
    const fresh = await approved(service, issuer, { sub }, "after-reset");
    expect(fresh.token.mesh).toBeNull();
    expect((await register(service, fresh, MESH_B)).status).toBe(200);
  });

  it("a reset ends a device flow waiting at its confirmation page: confirm, poll and register all fail, and a new flow from that browser goes to Google again", async () => {
    const sub = "610000000000000000061";
    const kept = await signIn(service, issuer, { sub }, "kept-page");
    expect(kept.callback.status).toBe(200);

    await resetAccount(service, issuer, sub);

    const approve = await kept.browser.post("/device/confirm", {
      csrf: kept.callback.csrf ?? "",
      action: "approve",
    });
    expect(approve.status).toBe(403);
    expect((await poll(service.url, kept.machine, kept.deviceCode)).json).toEqual({
      status: "denied",
    });
    const machine = await device("again");
    const started = await startDevice(service.url, machine);
    const entry = await kept.browser.get("/device");
    const sent = await kept.browser.post("/device", {
      code: String(started.json.userCode),
      csrf: entry.csrf ?? "",
    });
    expect(sent.status).toBe(303);
    expect(sent.location?.startsWith(`${issuer.url}/authorize?`)).toBe(true);
  });

  it("a Google sign-in that left for Google before a reset is refused when it comes back", async () => {
    const sub = "620000000000000000062";
    const machine = await device("in-flight");
    const started = await startDevice(service.url, machine);
    const browser = new Browser(service.url);
    const entry = await browser.get("/device");
    const sent = await browser.post("/device", {
      code: String(started.json.userCode),
      csrf: entry.csrf ?? "",
    });
    issuer.next = { sub };
    const google = await fetch(sent.location ?? "", { redirect: "manual" });

    await resetAccount(service, issuer, sub);

    const back = await browser.get(google.headers.get("location") ?? "");
    expect(back.status).toBe(403);
    expect(back.csrf).toBeNull();
  });

  it("replaying a callback URL, even when the provider would redeem its code again, shows the error page", async () => {
    issuer.allowCodeReuse = true;
    try {
      const flow = await signIn(service, issuer);
      expect(flow.callback.status).toBe(200);
      const replay = await flow.browser.get(flow.callbackUrl);
      expect(replay.status).toBe(400);
      expect(replay.csrf).toBeNull();
    } finally {
      issuer.allowCodeReuse = false;
    }
  });

  it("two polls at once get one answer and one slow_down", async () => {
    const machine = await device();
    const started = await startDevice(service.url, machine);
    const code = String(started.json.deviceCode);
    const statuses = (
      await Promise.all([poll(service.url, machine, code), poll(service.url, machine, code)])
    ).map((r) => r.status);
    expect(statuses.sort()).toEqual([428, 429]);
  });

  it("an account lists at most 64 nodes; the 65th registration is refused 409", async () => {
    const sub = "700000000000000000007";
    const statuses = [];
    for (let i = 0; i < 65; i++) {
      const minted = await approved(service, issuer, { sub }, `n${i}`);
      statuses.push((await register(service, minted, MESH_A)).status);
    }
    expect(statuses.slice(0, 64).every((status) => status === 200)).toBe(true);
    expect(statuses[64]).toBe(409);
    const next = await approved(service, issuer, { sub }, "n65");
    expect((next.token.mesh as { members: Array<unknown> }).members.length).toBe(64);
  });

  it("the registry keeps one meshId per sub, refuses another 409, lists members to the next login, and uses an assertion once", async () => {
    const sub = "200000000000000000002";
    const first = await approved(service, issuer, { sub });
    const registered = await register(service, first, MESH_A);
    expect(registered.status).toBe(200);
    const reused = await register(service, first, MESH_A);
    expect(reused.status).toBe(409);

    const second = await approved(service, issuer, { sub }, "box-2");
    const firstNodeId = await nodeIdFromSignPub(fromBase64url(first.machine.signPub));
    expect(second.token.mesh).toEqual({
      meshId: MESH_A,
      members: [
        {
          nodeId: firstNodeId,
          signPub: first.machine.signPub,
          noisePub: first.machine.noisePub,
          name: "box-1",
        },
      ],
    });
    const otherMesh = await register(service, second, MESH_B);
    expect(otherMesh.status).toBe(409);
  });

  it("forget needs a fresh proof by the node or another node of the same sub; stale or foreign proofs are refused", async () => {
    const sub = "300000000000000000003";
    const a = await approved(service, issuer, { sub }, "node-a");
    expect((await register(service, a, MESH_A)).status).toBe(200);
    const b = await approved(service, issuer, { sub }, "node-b");
    expect((await register(service, b, MESH_A)).status).toBe(200);
    const stranger = await approved(service, issuer, { sub: "300000000000000000099" }, "stranger");
    expect((await register(service, stranger, MESH_B)).status).toBe(200);
    const aId = await nodeIdFromSignPub(fromBase64url(a.machine.signPub));

    const now = serviceSeconds(stranger.token) * 1000;
    expect((await forget(service, aId, b.machine, now - 3 * 60_000)).status).toBe(400);
    expect((await forget(service, aId, stranger.machine, now)).status).toBe(403);
    expect((await forget(service, aId, b.machine, now)).status).toBe(200);

    const next = await approved(service, issuer, { sub }, "node-c");
    const members = (next.token.mesh as { members: Array<{ name: string }> }).members.map(
      (member) => member.name,
    );
    expect(members).toEqual(["node-b"]);
  });

  it("a Google-authenticated reset with its own CSRF step clears the account, so the next login may bind another mesh", async () => {
    const sub = "400000000000000000004";
    const a = await approved(service, issuer, { sub });
    expect((await register(service, a, MESH_A)).status).toBe(200);

    const browser = new Browser(service.url);
    const page = await browser.get("/reset");
    const sent = await browser.post("/reset", { csrf: page.csrf ?? "" });
    expect(sent.status).toBe(303);
    issuer.next = { sub };
    const google = await fetch(sent.location ?? "", { redirect: "manual" });
    const confirm = await browser.get(google.headers.get("location") ?? "");
    expect(confirm.status).toBe(200);
    expect(confirm.body).toContain(MESH_A);
    expect((await browser.post("/reset/confirm", {})).status).toBe(403);
    const done = await browser.post("/reset/confirm", { csrf: confirm.csrf ?? "" });
    expect(done.status).toBe(200);

    const b = await approved(service, issuer, { sub }, "box-2");
    expect(b.token.mesh).toBeNull();
    expect((await register(service, b, MESH_B)).status).toBe(200);
  });
});

describe("pen-login contract (device codes that expire at once)", () => {
  let issuer: FakeIssuer;
  let service: Service;
  beforeAll(async () => {
    ({ issuer, service } = await boot({ DEVICE_TTL_MS: "0" }));
  });
  afterAll(async () => {
    await service?.stop();
    await issuer?.close();
  });

  it("an expired device code polls 410 and its user code shows the expired page", async () => {
    const machine = await device();
    const started = await startDevice(service.url, machine);
    expect(started.status).toBe(200);
    expect(await poll(service.url, machine, String(started.json.deviceCode))).toEqual({
      status: 410,
      json: { status: "expired" },
    });
    const browser = new Browser(service.url);
    const entry = await browser.get("/device");
    const page = await browser.post("/device", {
      code: String(started.json.userCode),
      csrf: entry.csrf ?? "",
    });
    expect(page.status).toBe(410);
    expect(page.body).toMatch(/pen login/);
  });
});

describe("pen-login contract (tight per-source caps and JWKS refresh on every use)", () => {
  let issuer: FakeIssuer;
  let service: Service;
  beforeAll(async () => {
    ({ issuer, service } = await boot({
      SOURCE_SESSION_CAP: "3",
      SOURCE_DEVICE_CAP: "3",
      JWKS_TTL_MS: "0",
      JWKS_REFETCH_MS: "0",
    }));
  });
  afterAll(async () => {
    await service?.stop();
    await issuer?.close();
  });

  /** A fresh browser from source that submits a live code; returns the status of the code POST. */
  async function submitFrom(source: string): Promise<number> {
    const started = await startDevice(service.url, await device());
    const browser = new Browser(service.url, source);
    const entry = await browser.get("/device");
    return (
      await browser.post("/device", { code: String(started.json.userCode), csrf: entry.csrf ?? "" })
    ).status;
  }

  it("page loads create no session rows; a source past its live-session cap gets 429 while another source still signs in", async () => {
    const source = freshSource();
    // 10 page loads, then 4 sign-ins of 2 pages each, stay under the 20 pages a minute limit.
    for (let i = 0; i < 5; i++) {
      expect((await new Browser(service.url, source).get("/device")).status).toBe(200);
      expect((await new Browser(service.url, source).get("/reset")).status).toBe(200);
    }
    expect([await submitFrom(source), await submitFrom(source), await submitFrom(source)]).toEqual([
      303, 303, 303,
    ]);
    expect(await submitFrom(source)).toBe(429);
    expect(await submitFrom(freshSource())).toBe(303);
  });

  it("a source past its live-device cap gets 429 on device start while another source still starts", async () => {
    const source = freshSource();
    const statuses = [];
    for (let i = 0; i < 4; i++)
      statuses.push((await startDevice(service.url, await device(), source)).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect((await startDevice(service.url, await device(), freshSource())).status).toBe(200);
  });

  it("a rotated Google key verifies after exactly one JWKS fetch", async () => {
    await approved(service, issuer);
    const rotated = rsaKey("key-c");
    issuer.published.push(rotated);
    const fetches = issuer.jwksFetches;
    expect((await signIn(service, issuer, { signer: rotated })).callback.status).toBe(200);
    expect(issuer.jwksFetches - fetches).toBe(1);
    issuer.published.pop();
  });

  it("a failed or unreadable JWKS refresh keeps serving the cached keys", async () => {
    await approved(service, issuer);
    try {
      issuer.jwksOverride = { status: 500, body: "{}" };
      expect((await signIn(service, issuer)).callback.status).toBe(200);
      issuer.jwksOverride = { status: 200, body: "not json" };
      expect((await signIn(service, issuer)).callback.status).toBe(200);
      issuer.jwksOverride = null;
      expect((await signIn(service, issuer)).callback.status).toBe(200);
    } finally {
      issuer.jwksOverride = null;
    }
  });
});

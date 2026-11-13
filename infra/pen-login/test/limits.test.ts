// @effect-diagnostics globalFetch:off - The harness's HTTP helpers reach the in-process Worker through fetch.
// The per-source limits count per wall-clock minute, so these run the Worker and its Durable Object in this
// process on a clock the test holds: a burst can never straddle a window the way it can against wrangler dev.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { base64url } from "@goat/pen-protocol/login";
import type { Env } from "../src/env.ts";
import worker, { Login } from "../src/worker.ts";
import { api, Browser, device, freshSource, poll, startDevice } from "./harness.ts";
import { storage } from "./storage.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    readonly ctx: DurableObjectState;
    readonly env: Env;
    constructor(ctx: DurableObjectState, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const BASE = "http://pen-login.test";
const MINUTE = 60_000;
/** Mid-minute; only the test moves this clock, and only between bursts. */
const START = 1_794_300_030_000;

/** Routes fetch through the Worker to one Login object on node:sqlite, with Date held at START. */
function inProcess(): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
  const vars = {
    GOOGLE_CLIENT_ID: "client",
    GOOGLE_CLIENT_SECRET: "secret",
    LOGIN_SIGNING_KEY: base64url(new Uint8Array(32).fill(0x4c)),
  };
  const login = new Login({ storage: storage() } as unknown as DurableObjectState, vars as Env);
  const env = {
    ...vars,
    LOGIN: { idFromName: (name: string) => name, get: () => login },
  } as unknown as Env;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    worker.fetch(new Request(input, init) as Parameters<typeof worker.fetch>[0], env),
  );
}

async function registers(count: number, source: string): Promise<Array<number>> {
  const statuses = [];
  for (let i = 0; i < count; i++)
    statuses.push((await api(BASE, "/v1/mesh/register", {}, source)).status);
  return statuses;
}

describe("pen-login per-source limits (contract, on a clock the test holds)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("answer 429: device start past 10 a minute, pages past 20, register and forget past 30", async () => {
    inProcess();
    const machine = await device();
    const source = freshSource();
    const starts = [];
    for (let i = 0; i < 11; i++) starts.push((await startDevice(BASE, machine, source)).status);
    expect(starts.slice(0, 10).every((status) => status === 200)).toBe(true);
    expect(starts[10]).toBe(429);

    const browser = new Browser(BASE);
    const pages = [];
    for (let i = 0; i < 21; i++) pages.push((await browser.get("/device")).status);
    expect(pages.slice(0, 20).every((status) => status === 200)).toBe(true);
    expect(pages[20]).toBe(429);

    const calls = await registers(31, freshSource());
    expect(calls.slice(0, 30).every((status) => status === 400)).toBe(true);
    expect(calls[30]).toBe(429);

    const forgetter = freshSource();
    const forgets = [];
    for (let i = 0; i < 31; i++)
      forgets.push((await api(BASE, "/v1/mesh/forget", {}, forgetter)).status);
    expect(forgets.slice(0, 30).every((status) => status === 400)).toBe(true);
    expect(forgets[30]).toBe(429);

    // Register and forget draw on one registry budget.
    const shared = freshSource();
    expect((await registers(30, shared)).every((status) => status === 400)).toBe(true);
    expect((await api(BASE, "/v1/mesh/forget", {}, shared)).status).toBe(429);
  });

  it("a limit holds for its source only, which a client cannot claim, and for its minute only", async () => {
    inProcess();
    const source = freshSource();
    expect((await registers(31, source))[30]).toBe(429);
    expect((await registers(1, freshSource()))[0]).toBe(400);
    const forged = await fetch(BASE + "/v1/mesh/register", {
      method: "POST",
      headers: { "cf-connecting-ip": freshSource(), "x-pen-source": source },
      body: "{}",
    });
    expect(forged.status).toBe(400);
    vi.setSystemTime(START + MINUTE);
    expect((await registers(1, source))[0]).toBe(400);
  });

  it("polls with unknown device codes count per source: the eleventh in a minute is 429", async () => {
    inProcess();
    const machine = await device();
    const source = freshSource();
    const statuses = [];
    for (let i = 0; i < 11; i++) {
      const code = base64url(crypto.getRandomValues(new Uint8Array(32)));
      statuses.push((await poll(BASE, machine, code, source)).status);
    }
    expect(statuses.slice(0, 10).every((status) => status === 410)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

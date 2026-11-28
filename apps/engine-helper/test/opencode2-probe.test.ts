import test from "node:test";
import assert from "node:assert/strict";
import type { ProbeParams } from "../src/protocol.ts";
import { probeOpenCode2, type OpenCode2ProbeDependencies } from "../src/engines/opencode2/probe.ts";

const params: ProbeParams = { protocol: 1, engine: "opencode", cwd: "/workspace", launch: { binary: "custom-opencode", args: ["--custom"], env: { EXAMPLE: "value" } } };
const host = { now: () => "2026-11-29T00:00:00.000Z" };
const model = (id: string, changes: Record<string, unknown> = {}) => ({
  id, providerID: "provider", name: id, variants: [{ id: "low" }, { id: "high" }],
  family: "family", time: { released: 1 }, cost: [{ input: 1, output: 2 }], status: "active", ...changes,
});

function fake(options: { version?: string; models?: unknown; providers?: unknown; modelError?: boolean; providerError?: boolean; closeError?: boolean } = {}) {
  const calls: Array<[string, unknown]> = [];
  let closed = 0;
  const client = {
    model: { list: async (input: unknown) => { calls.push(["model.list", input]); if (options.modelError) throw new Error("secret model error"); return options.models ?? { data: [model("model-1")] }; } },
    provider: { list: async (input: unknown) => { calls.push(["provider.list", input]); if (options.providerError) throw new Error("secret provider error"); return options.providers ?? { data: [{ id: "provider", name: "Provider Name", activation: "disabled", settings: { apiKey: "secret" } }] }; } },
  };
  const runtime = { client, version: options.version ?? "2.2.5", close: async () => { closed++; if (options.closeError) throw new Error("secret cleanup error"); } };
  let clock = 0;
  const deps: OpenCode2ProbeDependencies = {
    select: async (actual) => { calls.push(["select", actual]); return { generation: "v2", version: "2.0.28" }; },
    startRuntime: async (actual) => { calls.push(["start", actual]); return runtime as unknown as Awaited<ReturnType<NonNullable<OpenCode2ProbeDependencies["startRuntime"]>>>; },
    now: () => clock, sleep: async (milliseconds) => { clock += milliseconds; },
  };
  return { deps, calls, closed: () => closed };
}

test("normal launch uses read-only inventory and v2 models remain visible when provider is disconnected", async () => {
  const f = fake({ models: { data: [model("model-1"), model("model-2", { name: "Alpha", time: { released: 2 } })] } });
  const result = await probeOpenCode2(params, host, f.deps);
  assert.equal(result.status, "ready");
  assert.deepEqual(result.auth, { status: "authenticated" });
  assert.equal(result.version, "2.2.5");
  assert.equal(result.capabilities?.turns.supportsNativeGoals, true);
  assert.deepEqual(result.models.map((m) => [m.slug, m.subProvider, m.isLegacy]), [["provider/model-2", "Provider Name", undefined], ["provider/model-1", "Provider Name", true]]);
  assert.equal(result.models[0]?.capabilities?.optionDescriptors?.[0]?.currentValue, "goat:default");
  assert.deepEqual(f.calls, [["select", params], ["start", { cwd: "/workspace", launch: params.launch }], ["model.list", { location: { directory: "/workspace" } }], ["provider.list", { location: { directory: "/workspace" } }], ["model.list", { location: { directory: "/workspace" } }], ["provider.list", { location: { directory: "/workspace" } }]]);
  assert.equal(f.closed(), 1);
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});

test("empty inventory is warning and unknown auth, with successful version capabilities", async () => {
  const f = fake({ models: { data: [] }, providers: { data: [] } });
  const result = await probeOpenCode2(params, host, f.deps);
  assert.equal(result.status, "warning");
  assert.deepEqual(result.auth, { status: "unknown" });
  assert.deepEqual(result.models, []);
  assert.equal(result.capabilities?.turns.supportsNativeGoals, true);
  assert.equal(f.closed(), 1);
});

test("provider name failure is optional and falls back to provider ID", async () => {
  for (const options of [{ providerError: true }, { providers: { data: "bad" } }, { providers: { data: [] } }]) {
    const f = fake(options);
    const result = await probeOpenCode2(params, host, f.deps);
    assert.equal(result.status, "ready");
    assert.equal(result.models[0]?.subProvider, "provider");
    assert.equal(f.closed(), 1);
  }
});

test("malformed or failed model catalog and failed teardown return errors without capabilities or secrets", async () => {
  for (const options of [{ models: { data: "bad" } }, { models: { data: [model("bad", { variants: null })] } }, { modelError: true }, { closeError: true }]) {
    const f = fake(options);
    const result = await probeOpenCode2(params, host, f.deps);
    assert.equal(result.status, "error");
    assert.equal(result.capabilities, undefined);
    assert.deepEqual(result.models, []);
    assert.doesNotMatch(JSON.stringify(result), /secret/);
    assert.equal(f.closed(), 1);
  }
});

test("native goals follow the running version, including prereleases and build metadata", async () => {
  for (const [version, enabled] of [["2.2.4", false], ["2.2.5-rc.1", false], ["2.2.5", true], ["2.2.5+build.1", true], ["2.3.0", true]] as const) {
    const f = fake({ version });
    const result = await probeOpenCode2(params, host, f.deps);
    assert.equal(result.capabilities?.turns.supportsNativeGoals, enabled, version);
    assert.equal(f.closed(), 1);
  }
});

test("invalid or v1 running version fails and still closes; v1 selection never starts", async () => {
  for (const version of ["1.9.0", "not a version", "opencode 2.2.5"]) {
    const f = fake({ version });
    const result = await probeOpenCode2(params, host, f.deps);
    assert.equal(result.status, "error");
    assert.equal(result.capabilities, undefined);
    assert.equal(f.closed(), 1);
  }
  const f = fake();
  f.deps.select = async () => ({ generation: "v1", version: "1.2.3" });
  const result = await probeOpenCode2(params, host, f.deps);
  assert.equal(result.status, "error");
  assert.equal(result.version, "1.2.3");
  assert.equal(f.closed(), 0);
});

test("missing binary is not installed and startup failure retains the selected version", async () => {
  const missing = await probeOpenCode2({ ...params, launch: { binary: "/definitely-not-an-opencode-binary", args: [], env: {} } }, host);
  assert.equal(missing.installed, false);
  assert.equal(missing.cli, "missing");
  assert.equal(missing.status, "error");
  assert.equal(missing.version, null);
  const f = fake();
  f.deps.startRuntime = async () => { throw new Error("secret startup failure"); };
  const failed = await probeOpenCode2(params, host, f.deps);
  assert.equal(failed.installed, true);
  assert.equal(failed.version, "2.0.28");
  assert.equal(failed.status, "error");
  assert.doesNotMatch(JSON.stringify(failed), /secret/);
});

test("binary version selection forwards arguments, cwd and launch environment before startup", async () => {
  const f = fake();
  delete f.deps.select;
  const cwd = process.cwd();
  const launch = { binary: process.execPath, args: ["-e", "if (process.env.PROBE_TEST === 'present' && process.cwd() === process.env.PROBE_CWD && process.argv.includes('--version')) process.stdout.write('2.0.28')", "--"], env: { PROBE_TEST: "present", PROBE_CWD: cwd } };
  const result = await probeOpenCode2({ ...params, cwd, launch }, host, f.deps);
  assert.equal(result.status, "ready");
  assert.deepEqual(f.calls[0], ["start", { cwd, launch }]);
  assert.equal(f.closed(), 1);
});

test("a failed model read cancels the concurrent provider read and closes the runtime", async () => {
  let cancelled = false;
  let closed = 0;
  const f = fake();
  f.deps.startRuntime = async () => ({
    version: "2.2.5",
    client: {
      model: { list: async () => { throw new Error("bad catalog"); } },
      provider: { list: async (_input: unknown, options: { signal: AbortSignal }) => new Promise<never>((_resolve, reject) => {
        options.signal.addEventListener("abort", () => { cancelled = true; reject(new Error("cancelled")); }, { once: true });
      }) },
    },
    close: async () => { closed++; },
  }) as unknown as Awaited<ReturnType<NonNullable<OpenCode2ProbeDependencies["startRuntime"]>>>;
  const result = await probeOpenCode2(params, host, f.deps);
  assert.equal(result.status, "error");
  assert.equal(cancelled, true);
  assert.equal(closed, 1);
});

test("cold and partial catalogs settle only after two matching non-empty reads", async () => {
  const f = fake(); let reads = 0; let closed = 0;
  const values = [[], [model("a")], [model("a"), model("b")], [model("a"), model("b")]];
  f.deps.startRuntime = async () => ({ version: "2.2.5", client: {
    model: { async list() { return { data: values[Math.min(reads++, values.length - 1)] }; } },
    provider: { async list() { return { data: [{ id: "provider", name: "Provider Name" }] }; } },
  }, close: async () => { closed++; } }) as unknown as Awaited<ReturnType<NonNullable<OpenCode2ProbeDependencies["startRuntime"]>>>;
  const result = await probeOpenCode2(params, host, f.deps);
  assert.equal(result.status, "ready"); assert.deepEqual(result.models.map((entry) => entry.slug), ["provider/a", "provider/b"]);
  assert.equal(reads, 4); assert.equal(closed, 1);
});

test("unsettled and permanently empty catalogs return a warning without models", async () => {
  for (const empty of [false, true]) {
    const f = fake(); let reads = 0;
    f.deps.startRuntime = async () => ({ version: "2.2.5", client: {
      model: { async list() { return { data: empty ? [] : [model(`model-${++reads}`)] }; } },
      provider: { async list() { return { data: [] }; } },
    }, close: async () => {} }) as unknown as Awaited<ReturnType<NonNullable<OpenCode2ProbeDependencies["startRuntime"]>>>;
    const result = await probeOpenCode2(params, host, f.deps);
    assert.equal(result.status, "warning"); assert.equal(result.models.length, 0);
    if (!empty) assert.ok(reads > 1);
  }
});

test("plugin activation errors retry on the injected clock before settling", async () => {
  const f = fake(); let reads = 0; let clock = 0; const delays: number[] = [];
  f.deps.now = () => clock; f.deps.sleep = async (ms) => { delays.push(ms); clock += ms; };
  f.deps.startRuntime = async () => ({ version: "2.2.5", client: {
    model: { async list() { reads++; if (reads <= 2) throw Object.assign(new Error("not ready"), { name: "ServiceUnavailableError", service: "plugin" }); return { data: [model("ready")] }; } },
    provider: { async list() { return { data: [] }; } },
  }, close: async () => {} }) as unknown as Awaited<ReturnType<NonNullable<OpenCode2ProbeDependencies["startRuntime"]>>>;
  const result = await probeOpenCode2(params, host, f.deps);
  assert.equal(result.status, "ready"); assert.equal(reads, 4); assert.deepEqual(delays, [1000, 1000, 250]);
});

test("endless plugin activation returns a warning within the injected 25-second budget", async () => {
  const f = fake(); let clock = 0, reads = 0, closed = 0;
  f.deps.now = () => clock; f.deps.sleep = async (ms) => { clock += ms; };
  f.deps.startRuntime = async () => ({ version: "2.2.5", client: {
    model: { async list() { reads++; throw Object.assign(new Error("not ready"), { name: "ServiceUnavailableError", service: "plugin" }); } },
    provider: { async list() { return { data: [] }; } },
  }, close: async () => { closed++; } }) as unknown as Awaited<ReturnType<NonNullable<OpenCode2ProbeDependencies["startRuntime"]>>>;
  const result = await probeOpenCode2(params, host, f.deps);
  assert.equal(result.status, "warning"); assert.equal(result.installed, true); assert.equal(result.version, "2.2.5");
  assert.deepEqual(result.models, []); assert.equal(result.capabilities?.turns.supportsNativeGoals, true);
  assert.match(result.message ?? "", /still starting its plugins/); assert.equal(clock, 25_000); assert.equal(reads, 25); assert.equal(closed, 1);
});

test("the probe budget includes version and server startup time", async () => {
  const f = fake(); let clock = 0, reads = 0;
  f.deps.now = () => clock; f.deps.sleep = async (ms) => { clock += ms; };
  f.deps.select = async () => { clock += 9_000; return { generation: "v2", version: "2.2.5" }; };
  f.deps.startRuntime = async () => { clock += 15_000; return { version: "2.2.5", client: {
    model: { async list() { reads++; return { data: [model(`partial-${reads}`)] }; } },
    provider: { async list() { return { data: [] }; } },
  }, close: async () => {} } as unknown as Awaited<ReturnType<NonNullable<OpenCode2ProbeDependencies["startRuntime"]>>>; };
  const result = await probeOpenCode2(params, host, f.deps);
  assert.equal(result.status, "warning"); assert.deepEqual(result.models, []); assert.equal(clock, 25_000);
});

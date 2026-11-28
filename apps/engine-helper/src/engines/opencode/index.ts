import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EngineModule } from "../../engine.ts";
import { fakeSdkPath } from "../../sdkLoader.ts";
import { OpenCodeSession } from "./session.ts";
import { client, sdk, startServer, verifyServerVersion } from "./runtime.ts";
import { variantCapabilities } from "./variant.ts";
import { HelperError } from "../../protocol.ts";
import { OpenCode2Session } from "../opencode2/session.ts";
import { probeOpenCode2 } from "../opencode2/probe.ts";
import { selectOpenCodeRuntime, type ProbedOpenCode } from "../opencode2/select.ts";
import type { LaunchSpec } from "../../protocol.ts";

const exec = promisify(execFile);
const opencode1Engine: EngineModule = {
  async start(params, host) {
    try { return await OpenCodeSession.create(await sdk(), params, host); }
    catch (error) { if (error instanceof HelperError) throw error; throw new Error("OpenCode engine initialization failed"); }
  },
  // status.ts:945-978 at 916b5ccc1b2: connected providers with models mean ready;
  // no catalog means warning and unknown auth, not necessarily signed out.
  async probe(params, host) {
    let version: string | null = null;
    let installed = false;
    try {
      const module = await sdk();
      if (fakeSdkPath("opencode") && module.startFakeServer) { installed = true; version = "1.15.13"; }
      else {
        let result: Awaited<ReturnType<typeof exec>>;
        try {
          result = await exec(params.launch?.binary || "opencode", [...(params.launch?.args ?? []), "--version"], { cwd: params.cwd ?? undefined, env: { ...process.env, ...params.launch?.env }, timeout: 10_000, maxBuffer: 64 * 1024 });
          installed = true;
        } catch (error) {
          installed = (error as NodeJS.ErrnoException).code !== "ENOENT";
          throw error;
        }
        const match = /\b(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/.exec(result.stdout.toString());
        if (!match?.[1]) throw new Error("version");
        version = match[1];
      }
      if (!version.startsWith("1.")) return { installed: true, version, status: "error", auth: { status: "unknown" }, models: [], checkedAt: host.now(), message: "OpenCode 1.x is required" };
      const server = await startServer(module, params.cwd ?? process.cwd(), params.launch);
      try {
        const api = client(module, server, params.cwd ?? process.cwd());
        version = await verifyServerVersion(api);
        const result = await api.provider.list({}, { throwOnError: true });
        const catalog = result.data; if (!catalog) throw new Error("inventory");
        const connected = new Set(catalog.connected);
        const models = catalog.all.filter((p) => connected.has(p.id)).flatMap((provider) => Object.values(provider.models).filter((model) => model.name?.trim()).map((model) => ({ slug: `${provider.id}/${model.id}`, name: model.name, isCustom: false, isDefault: catalog.default[provider.id] === model.id, capabilities: variantCapabilities(provider.id, Object.keys(model.variants ?? {})) })));
        const ready = connected.size > 0 && models.length > 0;
        return { installed: true, version, status: ready ? "ready" : "warning", auth: { status: ready ? "authenticated" : "unknown", type: "opencode" }, models, checkedAt: host.now() };
      } finally { await server.close(); }
    } catch {
      return { installed, version, cli: installed ? "present" : "missing", status: "error", auth: { status: "unknown" }, models: [], checkedAt: host.now(), message: "OpenCode could not be probed" };
    }
  },
};

// driver.ts:176-240: select from the installed runtime; the spawned server verifies its own version.
async function generation(cwd: string | null, launch: LaunchSpec | null): Promise<ProbedOpenCode> {
  const environment = { ...process.env, ...launch?.env };
  const fake2 = environment.GOAT2_ENGINE_HELPER_SDK_OPENCODE2;
  if (fake2?.trim()) return { generation: "v2", version: environment.GOAT2_ENGINE_HELPER_FAKE_OPENCODE2_VERSION || "2.0.28" };
  if (fakeSdkPath("opencode", environment)) return { generation: "v1", version: "1.15.13" };
  return selectOpenCodeRuntime({ ...(launch?.binary ? { binary: launch.binary } : {}), ...(launch?.args ? { args: launch.args } : {}), ...(cwd ? { cwd } : {}), environment });
}

export const opencodeEngine: EngineModule = {
  async start(params, host) {
    try {
      const selected = await generation(params.cwd, params.launch);
      return selected.generation === "v2" ? await OpenCode2Session.create(params, host) : await opencode1Engine.start(params, host);
    } catch (error) {
      if (error instanceof HelperError) throw error;
      throw new HelperError("start_failed", "OpenCode runtime generation could not be selected");
    }
  },
  async probe(params, host) {
    try {
      const selected = await generation(params.cwd, params.launch);
      if (selected.generation === "v2") {
        const fake = ({ ...process.env, ...params.launch?.env }).GOAT2_ENGINE_HELPER_SDK_OPENCODE2;
        let clock = 0;
        return await probeOpenCode2(params, host, { select: async () => selected, ...(fake?.trim() ? { now: () => clock, sleep: async (milliseconds: number) => { clock += milliseconds; } } : {}) });
      }
      return await opencode1Engine.probe!(params, host);
    } catch {
      // Preserve v1's installed/missing classification if the CLI did not identify itself.
      return opencode1Engine.probe!(params, host);
    }
  },
};

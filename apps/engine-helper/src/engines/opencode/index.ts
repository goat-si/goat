import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EngineModule } from "../../engine.ts";
import { fakeSdkPath } from "../../sdkLoader.ts";
import { OpenCodeSession } from "./session.ts";
import { client, sdk, startServer } from "./runtime.ts";
import { variantCapabilities } from "./variant.ts";

const exec = promisify(execFile);
export const opencodeEngine: EngineModule = {
  async start(params, host) {
    try { return await OpenCodeSession.create(await sdk(), params, host); }
    catch { throw new Error("OpenCode engine initialization failed"); }
  },
  // status.ts:945-978 at 916b5ccc1b2: connected providers with models mean ready;
  // no catalog means warning and unknown auth, not necessarily signed out.
  async probe(params, host) {
    let version: string | null = null;
    try {
      const module = await sdk();
      if (fakeSdkPath("opencode") && module.startFakeServer) version = "1.15.13";
      else {
        const result = await exec(params.launch?.binary || "opencode", [...(params.launch?.args ?? []), "--version"], { cwd: params.cwd ?? undefined, env: { ...process.env, ...params.launch?.env }, timeout: 10_000, maxBuffer: 64 * 1024 });
        const match = /\b(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/.exec(result.stdout);
        if (!match?.[1]) throw new Error("version");
        version = match[1];
      }
      if (!version.startsWith("1.")) return { installed: true, version, status: "error", auth: { status: "unknown" }, models: [], checkedAt: host.now(), message: "OpenCode 1.x is required" };
      const server = await startServer(module, params.cwd ?? process.cwd(), params.launch);
      try {
        const api = client(module, server, params.cwd ?? process.cwd());
        const result = await api.provider.list({}, { throwOnError: true });
        const catalog = result.data; if (!catalog) throw new Error("inventory");
        const connected = new Set(catalog.connected);
        const models = catalog.all.filter((p) => connected.has(p.id)).flatMap((provider) => Object.values(provider.models).filter((model) => model.name?.trim()).map((model) => ({ slug: `${provider.id}/${model.id}`, name: model.name, isCustom: false, isDefault: catalog.default[provider.id] === model.id, capabilities: variantCapabilities(provider.id, Object.keys(model.variants ?? {})) })));
        const ready = connected.size > 0 && models.length > 0;
        return { installed: true, version, status: ready ? "ready" : "warning", auth: { status: ready ? "authenticated" : "unknown", type: "opencode" }, models, checkedAt: host.now() };
      } finally { await server.close(); }
    } catch {
      return { installed: version !== null, version, status: "error", auth: { status: "unknown" }, models: [], checkedAt: host.now(), message: "OpenCode could not be probed" };
    }
  },
};

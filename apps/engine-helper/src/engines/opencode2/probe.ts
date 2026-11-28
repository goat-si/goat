import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ServerProviderModel } from "@goat2/contracts-rs";
import type { EngineHost } from "../../engine.ts";
import type { ProbeParams, ProbeResult } from "../../protocol.ts";
import { capabilitiesForOpenCode2 } from "./capabilities.ts";
import { modelVariantCapabilities } from "./modelRef.ts";
import { startOpenCode2Runtime, type OpenCode2Runtime } from "./runtime.ts";
import { classifyOpenCodeCliVersion, type ProbedOpenCode } from "./select.ts";

const exec = promisify(execFile);
type ProbeRuntime = Pick<OpenCode2Runtime, "client" | "version" | "close">;
export interface OpenCode2ProbeDependencies {
  select?: (params: ProbeParams) => Promise<ProbedOpenCode>;
  startRuntime?: (options: { cwd: string; launch: ProbeParams["launch"] }) => Promise<ProbeRuntime>;
  now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}
const sleep = (milliseconds: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, milliseconds);
  const cancel = () => { clearTimeout(timer); signal.removeEventListener("abort", cancel); reject(new Error("cancelled")); };
  signal.addEventListener("abort", cancel, { once: true }); if (signal.aborted) cancel();
});

async function selectBinary(params: ProbeParams): Promise<ProbedOpenCode> {
  const result = await exec(params.launch?.binary || "opencode", [...(params.launch?.args ?? []), "--version"], {
    cwd: params.cwd ?? undefined, env: { ...process.env, ...params.launch?.env }, timeout: 10_000, maxBuffer: 64 * 1024,
  });
  const selected = classifyOpenCodeCliVersion(result.stdout);
  if (!selected) throw new Error("Invalid version");
  return selected;
}

// Bound native reads even if a transport fails to honor cancellation.
async function bounded<T>(ms: number, parent: AbortSignal, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    cancel = () => { controller.abort(); reject(new Error("Inventory read cancelled")); };
    parent.addEventListener("abort", cancel, { once: true });
    if (parent.aborted) cancel();
    timer = setTimeout(() => { controller.abort(); reject(new Error("Inventory read timed out")); }, ms);
  });
  try { return await Promise.race([read(controller.signal), deadline]); }
  finally { clearTimeout(timer); if (cancel) parent.removeEventListener("abort", cancel); controller.abort(); }
}

type CatalogModel = { providerID: string; id: string; name: string; variants: string[]; family?: string; released: number; deprecated: boolean; price?: string };
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

function readModels(value: unknown): CatalogModel[] {
  if (!object(value) || !Array.isArray(value.data)) throw new Error("Invalid model catalog");
  return value.data.map((model: unknown) => {
    if (!object(model) || !nonempty(model.providerID) || !nonempty(model.id) || !nonempty(model.name) ||
      !Array.isArray(model.variants) || !model.variants.every((variant: unknown) => object(variant) && nonempty(variant.id)) ||
      !object(model.time) || typeof model.time.released !== "number" || !Number.isFinite(model.time.released) ||
      !Array.isArray(model.cost) || !model.cost.every((cost: unknown) => object(cost) && typeof cost.input === "number" && Number.isFinite(cost.input) && typeof cost.output === "number" && Number.isFinite(cost.output)) ||
      !["active", "alpha", "beta", "deprecated"].includes(String(model.status)) || (model.family !== undefined && typeof model.family !== "string")) throw new Error("Invalid model catalog");
    const baseCost = model.cost.find((cost: Record<string, unknown>) => cost.tier === undefined);
    return {
      providerID: model.providerID, id: model.id, name: model.name,
      variants: model.variants.map((variant: { id: string }) => variant.id),
      ...(model.family === undefined ? {} : { family: model.family }), released: model.time.released,
      deprecated: model.status === "deprecated", ...(baseCost ? { price: `${baseCost.input}/${baseCost.output}` } : {}),
    };
  });
}

function providerNames(value: unknown): Map<string, string> {
  if (!object(value) || !Array.isArray(value.data) || !value.data.every((provider: unknown) => object(provider) && nonempty(provider.id) && typeof provider.name === "string")) throw new Error("Invalid provider catalog");
  return new Map(value.data.map((provider: { id: string; name: string }) => [provider.id, provider.name]));
}

// status.ts:385-503: compare two non-empty catalog reads before reporting inventory.
function fingerprint(models: CatalogModel[], names: Map<string, string>): string | undefined {
  if (!models.length) return undefined;
  return models.map((model) => JSON.stringify([model.providerID, model.id, model.name, names.get(model.providerID), [...model.variants].toSorted()])).toSorted().join("\n");
}
function activating(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { name?: unknown; _tag?: unknown; service?: unknown };
  return (value.name === "ServiceUnavailableError" || value._tag === "ServiceUnavailableError") && value.service === "plugin";
}

// status.ts:145-210, 366-380, 647-675 at 916b5ccc1b.
function projectModels(catalog: CatalogModel[], names: Map<string, string>): ServerProviderModel[] {
  const releaseLine = (id: string) => id.toLowerCase().split(/[-_]/).map((token) => /^\d+(\.\d+)?[bm]$/.test(token) ? token : token.replace(/[\d.]+/g, "")).join("");
  return catalog.map((entry) => {
    const label = names.get(entry.providerID)?.trim() || entry.providerID;
    const superseded = !!entry.family && catalog.some((other) => other.providerID === entry.providerID && other.family === entry.family && !other.deprecated && other.released > entry.released && (releaseLine(other.id) === releaseLine(entry.id) || (entry.price !== undefined && other.price === entry.price)));
    return {
      slug: `${entry.providerID}/${entry.id}`, name: entry.name,
      ...(label.toLowerCase() === "opencode" ? {} : { subProvider: label }),
      isCustom: false, ...(entry.deprecated || superseded ? { isLegacy: true } : {}),
      capabilities: modelVariantCapabilities(entry.providerID, entry.variants),
    };
  }).toSorted((a, b) => a.name.localeCompare(b.name));
}

/** Standalone v2 probe. Selection precedes startup; the running server version is authoritative. */
export async function probeOpenCode2(params: ProbeParams, host: Pick<EngineHost, "now">, dependencies: OpenCode2ProbeDependencies = {}): Promise<ProbeResult> {
  let installed = false;
  let version: string | null = null;
  const now = dependencies.now ?? Date.now; const budgetDeadline = now() + 25_000;
  try {
    let selected: ProbedOpenCode;
    try { selected = await (dependencies.select ?? selectBinary)(params); }
    catch (error) { installed = (error as NodeJS.ErrnoException)?.code !== "ENOENT"; throw error; }
    installed = true;
    version = selected.version;
    if (selected.generation !== "v2") throw new Error("Not OpenCode 2");
    const cwd = params.cwd ?? process.cwd();
    const runtime = await (dependencies.startRuntime ?? startOpenCode2Runtime)({ cwd, launch: params.launch });
    try {
      const actual = classifyOpenCodeCliVersion(runtime.version);
      if (!actual || actual.generation !== "v2" || actual.version !== runtime.version) throw new Error("Invalid running version");
      version = runtime.version;
      const input = { location: { directory: cwd } };
      const wait = dependencies.sleep ?? sleep;
      const read = async (deadline = 20_000) => {
        const reads = new AbortController();
        try {
          const [models, names] = await Promise.all([
            bounded(Math.min(20_000, deadline), reads.signal, (signal) => runtime.client.model.list(input, { signal })).then(readModels),
            bounded(Math.min(3_000, deadline), reads.signal, (signal) => runtime.client.provider.list(input, { signal })).then(providerNames).catch(() => new Map<string, string>()),
          ]);
          return { models, names };
        } finally { reads.abort(); }
      };
      // GOAT 2's host and helper cap probes at 30s. Return a useful warning before that cap.
      const controller = new AbortController();
      const pending = (): ProbeResult => ({ installed, version, status: "warning", auth: { status: "unknown" }, models: [], checkedAt: host.now(), capabilities: capabilitiesForOpenCode2(version!), message: "OpenCode is still starting its plugins; models will appear on the next check." });
      let first: Awaited<ReturnType<typeof read>>;
      for (;;) {
        const remaining = budgetDeadline - now(); if (remaining <= 0) return pending();
        try { first = await read(remaining); break; }
        catch (error) {
          if (now() >= budgetDeadline || (error instanceof Error && error.message === "Inventory read timed out")) return pending();
          if (!activating(error)) throw error;
          await wait(Math.min(1_000, budgetDeadline - now()), controller.signal);
        }
      }
      let settled: Awaited<ReturnType<typeof read>> | undefined;
      let previous = fingerprint(first.models, first.names); const deadline = Math.min(now() + 5_000, budgetDeadline);
      while (now() < deadline) {
        await wait(Math.min(250, deadline - now()), controller.signal);
        const remaining = deadline - now(); if (remaining <= 0) break;
        let current: Awaited<ReturnType<typeof read>>;
        try { current = await read(remaining); } catch { break; }
        const next = fingerprint(current.models, current.names);
        if (next !== undefined && next === previous) { settled = current; break; }
        previous = next;
      }
      controller.abort();
      if (!settled) return pending();
      const { models, names } = settled;
      const inventory = projectModels(models, names);
      const ready = inventory.length > 0;
      return { installed, version, status: ready ? "ready" : "warning", auth: { status: ready ? "authenticated" : "unknown" }, models: inventory, checkedAt: host.now(), capabilities: capabilitiesForOpenCode2(version), message: ready ? `OpenCode ${version} lists ${inventory.length} model${inventory.length === 1 ? "" : "s"}.` : "OpenCode 2 is running, but it did not list any models yet." };
    } finally { await runtime.close(); }
  } catch {
    return { installed, version, cli: installed ? "present" : "missing", status: "error", auth: { status: "unknown" }, models: [], checkedAt: host.now(), message: "OpenCode could not be probed" };
  }
}

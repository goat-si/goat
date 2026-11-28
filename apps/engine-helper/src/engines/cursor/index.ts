import type { InteractionUpdate, Run, SDKAgent, CursorAgentPlatform } from "@cursor/sdk";
import type { EngineHost, EngineModule, EngineSession } from "../../engine.ts";
import { HelperError, type EngineInput, type InitializeParams, type RequestAnswer, type TurnSettings } from "../../protocol.ts";
import { containRejections } from "../../rejections.ts";
import { loadSdk } from "../../sdkLoader.ts";
import { classifyCursorRejection } from "./rejections.ts";
import { cursorMcpServers, cursorSdkModelSelection, makeCursorAgentOptions } from "./options.ts";
import { CursorProjection } from "./projection.ts";
import { cursorFailure } from "./errors.ts";
import { cursorCatalog } from "./catalog.ts";
import { errorItem } from "../../items.ts";

// Redact credentials from every event and diagnostic emitted by this adapter.
function safeHost(host: EngineHost, secrets: ReadonlyArray<string>): EngineHost {
  const redact = (value: unknown): unknown => {
    if (typeof value === "string") {
      let result = value;
      for (const secret of secrets) if (secret) result = result.split(secret).join("[redacted]");
      return result.replace(/Bearer\s+[^\s"\x27]+/gi, "Bearer [redacted]");
    }
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /^(authorization|password|secret|api[_-]?key|access[_-]?token|bearer[_-]?token)$/i.test(k) ? "[redacted]" : redact(v)]));
    return value;
  };
  const tails = new Map<string, string>();
  const keep = Math.max(0, ...secrets.map(secret => secret.length - 1));
  const emitTail = (turnId: string, itemId: string) => {
    const tail = tails.get(itemId);
    if (tail) host.emit({ type: "text_delta", turnId, itemId, text: redact(tail) as string });
    tails.delete(itemId);
  };
  return {
    now: host.now,
    emit: event => {
      if (event.type === "text_delta") {
        const text = (tails.get(event.itemId) ?? "") + event.text;
        let cutoff = Math.max(0, text.length - keep);
        for (const secret of secrets) {
          if (!secret) continue;
          const start = text.indexOf(secret, Math.max(0, cutoff - secret.length + 1));
          if (start >= 0 && start < cutoff && start + secret.length > cutoff) cutoff = start;
        }
        tails.set(event.itemId, text.slice(cutoff));
        if (cutoff) host.emit({ ...event, text: redact(text.slice(0, cutoff)) as string });
        return;
      }
      if (event.type === "item_completed") emitTail(event.turnId, event.item.id);
      if (event.type === "turn_finished") {
        for (const itemId of tails.keys()) emitTail(event.turnId, itemId);
      }
      host.emit(redact(event) as typeof event);
    },
    log: (level, message) => host.log(level, redact(message) as string),
    fail: reason => host.fail(redact(reason) as string),
  };
}

type Sdk = typeof import("@cursor/sdk");
let contained = false;
async function sdk(): Promise<Sdk> {
  if (!contained) { containRejections(classifyCursorRejection); contained = true; }
  return loadSdk<Sdk>("cursor", "@cursor/sdk");
}

// v1 credentialScope.ts:8-38: never send an inherited key to an instance-specific backend.
function setupEnvironment(params: Pick<InitializeParams, "launch">) {
  const env = params.launch?.env ?? {};
  if (env.CURSOR_BACKEND_URL && env.CURSOR_BACKEND_URL !== process.env.CURSOR_BACKEND_URL && !env.CURSOR_API_KEY) {
    delete process.env.CURSOR_API_KEY;
  }
  Object.assign(process.env, env);
  if (params.launch?.binary || params.launch?.args?.length) {
    throw new HelperError("start_failed", "Cursor SDK does not support a CLI binary or argument override.");
  }
}

class CursorSession implements EngineSession {
  readonly engineRef: string;
  private active: { run: Run; projection: CursorProjection; interrupted: boolean; prompt: string; finalized: boolean } | undefined;
  private starting = false;
  private preamble: string;
  private interruptedPrompt: string | undefined;
  private readonly agent: SDKAgent;
  private readonly params: InitializeParams;
  private readonly host: EngineHost;
  private readonly platform: CursorAgentPlatform;
  private recoverAbandoned: boolean;
  constructor(agent: SDKAgent, platform: CursorAgentPlatform, params: InitializeParams, host: EngineHost) {
    this.agent = agent; this.platform = platform; this.params = params; this.host = host;
    this.recoverAbandoned = params.resume !== null;
    this.engineRef = agent.agentId;
    this.preamble = params.resume ? "" : [params.instructions?.appendSystemPrompt, params.instructions?.firstMessagePreamble].filter(Boolean).join("\n\n");
  }
  async startTurn(inputs: ReadonlyArray<EngineInput>, settings: TurnSettings) {
    if (this.starting || this.active) return { status: "declined" as const, reason: "a turn is already running" };
    if (inputs.some(i => i.attachments.length)) return { status: "declined" as const, reason: "Cursor helper cannot resolve attachment blobs" };
    if (settings.runtimeMode !== this.params.runtimeMode) return { status: "declined" as const, reason: "Cursor cannot change runtime mode within a session" };
    const text = inputs.map(i => i.text).join("\n");
    if (!text.trim()) return { status: "declined" as const, reason: "Cursor requires non-empty text" };
    // v1 steerPrompt.ts:10-23: a cancelled run is absent from Cursor history.
    const prompt = this.interruptedPrompt === undefined ? text : `Your previous turn was interrupted and is missing from your history. Some of its work may already be done. Its request was:\n\n${this.interruptedPrompt}\n\nThe new message, which may continue or change that request:\n\n${text}`;
    const message = [this.preamble, prompt].filter(Boolean).join("\n\n");
    this.starting = true;
    let projection: CursorProjection | undefined;
    let activeRef: NonNullable<CursorSession["active"]> | undefined;
    const pending: InteractionUpdate[] = [];
    try {
      const send = () => this.agent.send(message, {
        model: cursorSdkModelSelection(settings.modelSelection), mode: "agent",
        ...(this.params.mcp === null ? {} : { mcpServers: cursorMcpServers(this.params)! }),
        onDelta: ({ update }) => { if (activeRef?.finalized) return; if (projection) projection.update(update); else pending.push(update); },
      });
      let run: Run;
      try { run = await send(); } catch (error) {
        if (!this.recoverAbandoned || !(error instanceof Error) || !/already has active run/i.test(error.message)) throw error;
        this.recoverAbandoned = false;
        // v1 CursorAgentSdk.ts:633-685: find the newest abandoned local run across pages.
        let cursor: string | undefined;
        let abandoned: Run | undefined;
        do {
          const page = await this.platform.listRuns(this.engineRef, cursor === undefined ? {} : { cursor });
          abandoned = page.items.findLast(candidate => candidate.status === "running") ?? abandoned;
          cursor = page.nextCursor;
        } while (cursor !== undefined);
        if (!abandoned) throw error;
        await this.platform.cancelRun(abandoned.id);
        pending.length = 0;
        run = await send();
      }
      this.recoverAbandoned = false;
      projection = new CursorProjection(run.id, this.engineRef, settings.modelSelection.instanceId, this.host);
      const active = { run, projection, interrupted: false, prompt: message, finalized: false };
      activeRef = active;
      this.active = active;
      this.preamble = "";
      this.interruptedPrompt = undefined;
      for (const update of pending) projection.update(update);
      setImmediate(() => { void this.finish(active); });
      return { status: "accepted" as const, turnId: run.id };
    } catch (error) {
      const failure = cursorFailure(error);
      if (failure.auth) this.host.emit({ type: "auth_required", turnId: null, url: null, message: failure.message });
      return { status: "declined" as const, reason: failure.message };
    } finally { this.starting = false; }
  }
  private async finish(active: NonNullable<CursorSession["active"]>) {
    let outcome: { type: "done" } | { type: "failed"; reason: string } | { type: "interrupted" };
    try {
      const result = await active.run.wait();
      if (active.finalized) return;
      if (result.status === "finished") active.projection.fallback(result.result);
      if (active.interrupted || result.status === "cancelled") {
        this.interruptedPrompt = active.prompt;
        outcome = { type: "interrupted" };
      } else if ((result.status === "finished" || (active.projection.turnEnded && result.status === "error" && ["Agent turn stopped after repeated resume attempts made no progress", "Connection failed repeatedly"].includes(result.error?.message ?? ""))) && active.projection.transportFailure === undefined) {
        outcome = { type: "done" };
      } else {
        const failure = active.projection.transportFailure === undefined ? cursorFailure(result.error) : { message: "Cursor transport failed.", kind: "transport_error" as const, auth: false };
        if (failure.auth) this.host.emit({ type: "auth_required", turnId: active.run.id, url: null, message: failure.message });
        const id = `${this.engineRef}:${active.run.id}:error`;
        this.host.emit({ type: "item_completed", turnId: active.run.id, item: errorItem({ id, turnId: active.run.id, driver: "cursor", now: this.host.now(), status: "failed" }, failure.message, failure.kind), locator: null });
        outcome = { type: "failed", reason: failure.message };
      }
    } catch (cause) {
      if (active.finalized) return;
      const failure = cursorFailure(cause);
      if (failure.auth && !active.interrupted) this.host.emit({ type: "auth_required", turnId: active.run.id, url: null, message: failure.message });
      outcome = active.interrupted ? { type: "interrupted" } : { type: "failed", reason: failure.message };
      if (active.interrupted) this.interruptedPrompt = active.prompt;
    }
    this.finalize(active, outcome);
  }
  private finalize(active: NonNullable<CursorSession["active"]>, outcome: { type: "done" } | { type: "failed"; reason: string } | { type: "interrupted" }) {
    if (active.finalized) return;
    active.finalized = true;
    active.projection.flush();
    if (this.active === active) this.active = undefined;
    this.host.emit({ type: "turn_finished", turnId: active.run.id, outcome });
  }
  async steer(turnId: string, inputs: ReadonlyArray<EngineInput>) {
    const active = this.active;
    if (!active || active.run.id !== turnId) return { status: "declined" as const, reason: "no matching active turn" };
    const text = inputs.map(i => i.text).join("\n");
    if (!text.trim() || inputs.some(i => i.attachments.length)) return { status: "declined" as const, reason: "Cursor steer requires text without attachments" };
    try { return (await active.run.steer?.(text)) === "complete_delivered" ? { status: "accepted" as const } : { status: "declined" as const, reason: "Cursor declined steering" }; }
    catch { return { status: "unknown" as const, reason: "Cursor steering failed" }; }
  }
  async interrupt(turnId: string) {
    const active = this.active;
    if (!active || active.run.id !== turnId) return;
    active.interrupted = true;
    try { await active.run.cancel(); } catch { throw new HelperError("transport", "Cursor could not interrupt the run."); }
    // v1 adapter.ts:1750-1772: settle even if the SDK never resolves wait after cancel.
    setTimeout(() => { if (!active.finalized) { this.interruptedPrompt = active.prompt; this.finalize(active, { type: "interrupted" }); } }, 10_000).unref();
  }
  async answerRequest(_key: string, _answer: RequestAnswer) { throw new HelperError("bad_request", "Cursor SDK has no live approval or question callbacks"); }
  async shutdown() {
    try { if (this.active) { this.active.interrupted = true; await this.active.run.cancel(); } this.agent.close(); }
    catch { throw new HelperError("transport", "Cursor could not close the agent."); }
  }
}

export const cursorEngine: EngineModule = {
  async start(params, host) {
    setupEnvironment(params);
    try {
      const library = await sdk();
      const key = process.env.CURSOR_API_KEY?.trim() || undefined;
      const options = makeCursorAgentOptions(params, key);
      // v1 CursorAgentSdk.ts:436-459: prime sandbox support before Full access.
      if (options.local?.sandboxOptions?.enabled === false) {
        try {
          const p = await library.createAgentPlatform({ workspaceRef: params.cwd });
          const release = await p.prewarmLocalWorkspace({ ...(key ? { apiKey: key } : {}), local: { cwd: params.cwd, settingSources: [], sandboxOptions: { enabled: true } } });
          await release();
        } catch { host.log("debug", "Cursor sandbox prewarm failed"); }
      }
      const shared = await library.createAgentPlatform({ workspaceRef: params.cwd });
      const platform = new library.CursorAgentPlatform(shared.store, shared.checkpointStore, shared.eventStore, shared.eventNotifier, params.cwd);
      const agent = params.resume === null ? await platform.createAgent(options) : await platform.resumeAgent(params.resume, options);
      const secrets = [key ?? "", params.mcp?.bearerToken ?? "", ...Object.entries(process.env).filter(([name]) => /CURSOR.*(token|secret|password|api.?key)/i.test(name)).map(([, value]) => value ?? ""), ...Object.entries(params.launch?.env ?? {}).filter(([name]) => /token|secret|password|api.?key/i.test(name)).map(([, value]) => value)];
      return new CursorSession(agent, platform, params, safeHost(host, secrets));
    } catch (error) {
      if (error instanceof HelperError) throw error;
      throw new HelperError("start_failed", "Cursor SDK could not open the agent.");
    }
  },
  async probe(params, host) {
    setupEnvironment(params);
    const checkedAt = host.now();
    let library: Sdk;
    try { library = await sdk(); } catch { return { installed: false, version: null, status: "error", auth: { status: "unknown" }, models: [], checkedAt, message: "Cursor SDK could not be loaded." }; }
    const key = process.env.CURSOR_API_KEY?.trim();
    if (!key) return { installed: true, version: "1.2.0", status: "error", auth: { status: "unauthenticated" }, models: [], checkedAt, message: "Sign in with Cursor or add CURSOR_API_KEY in provider settings." };
    try {
      // v1 status.ts:255-411 / CursorSdkCatalog.ts:115-182: catalog queries do not start a turn.
      const [user, models] = await Promise.all([library.Cursor.me({ apiKey: key }), library.Cursor.models.list({ apiKey: key })]);
      const discovered = cursorCatalog(models);
      return { installed: true, version: "1.2.0", status: discovered.length ? "ready" : "warning", auth: { status: "authenticated", type: "api-key", label: user.apiKeyName && !user.apiKeyName.includes(key) ? `Cursor API key (${user.apiKeyName})` : "Cursor API key" }, models: discovered, checkedAt };
    } catch (error) {
      const unauthenticated = error instanceof Error && /auth/i.test(error.name);
      return { installed: true, version: "1.2.0", status: "error", auth: { status: unauthenticated ? "unauthenticated" : "unknown" }, models: [], checkedAt, message: unauthenticated ? "Cursor SDK authentication failed." : "Cursor SDK catalog request failed." };
    }
  },
};

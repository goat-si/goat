// Fake host provider world for verification scenes and the browser prototype only (marked Demo in the UI). It serves
// the approved provider frames (docs/part2/provider-wire.md) from a fixed list: the states of Paper board 1PBB-2
// (drawn from v1 916b5ccc code), v1's default model ids per driver (packages/contracts/src/model.ts:126-160) and the
// ACP registry agents of board 1QAN-2 (live registry index, 2026-11-28). It never runs or signs in to a real provider:
// install and sign-in flows step through v1's phases on a timer, and a demo sign-in completes only when a test or the
// scene calls completeAuth.
// Capabilities are not shown by the provider screens; the demo entries carry lane C's capabilities fixture
// (packages/contracts-rs/test/fixtures.gen.ts, kept in sync by lane C's drift test) so they are whole
// ServerProviderEntry values. Real capabilities always come from the host, per driver.
import { provider_capabilities__example as CAPABILITIES } from "../../../../packages/contracts-rs/test/fixtures.gen.ts";
import type { ProviderCapabilities } from "@goat2/contracts-rs";
import type {
  AcpRegistrySearchAgent, ProviderAuthState, ProviderCommandBody, ProviderCommandValue, ProviderInstallState,
  ProviderProbeResult, ServerProviderEntry, ServerProviderModel,
} from "../providers/wire.ts";

export type ProviderCommandOutcome =
  | { ok: true; value: ProviderCommandValue }
  | { ok: false; error: { code: "not_found" | "invalid_request" | "failed_precondition"; reason: string; message: string; retryable: false } };

const model = (slug: string, name: string, isDefault = false): ServerProviderModel =>
  ({ slug, name, isCustom: false, ...(isDefault ? { isDefault: true } : {}), capabilities: null });

const probe = (at: string, p: Partial<ProviderProbeResult> & Pick<ProviderProbeResult, "installed" | "status">): ProviderProbeResult =>
  ({ version: null, auth: { status: "unknown" }, models: [], checkedAt: at, ...p });

const setup = (canAuthenticate: boolean, canInstall: boolean) => ({ canAuthenticate, canInstall });

/** What a registry agent advertises after initialize (v1 ProviderAuthMethod); v1 shows "Discovering sign-in methods…"
 * until an auth state lists methods (ProviderAuthenticationSection.tsx:68-73), so a host sends them idle. */
const agentAuth = (instanceId: string): ProviderAuthState => ({
  instanceId, phase: "idle", flowId: null, authorizationUrl: null, expiresAt: null, message: null,
  methods: [{ id: "agent-login", name: "Sign in with the agent", description: null, type: "agent" }],
});

/** Board 1PBB-2: every local v1 driver kind (providerDriverMeta.ts) with the state the board shows. */
export function demoProviderEntries(at: string): ServerProviderEntry[] {
  const e = (instanceId: string, driver: string, p: ProviderProbeResult, extra: Partial<ServerProviderEntry> = {}): ServerProviderEntry =>
    ({ instanceId, driver, enabled: true, capabilities: CAPABILITIES as ProviderCapabilities, probe: p, ...extra });
  return [
    e("codex", "codex", probe(at, { installed: true, version: "0.167.0", cli: "present", status: "ready",
      auth: { status: "authenticated", type: "chatgpt", label: "ChatGPT Pro", email: "you@example.com", canLogout: true },
      models: [model("gpt-6-astra", "GPT-6 Astra", true), model("gpt-6.1-sol", "GPT-6.1 Sol"), model("gpt-6.1-terra", "GPT-6.1 Terra"), model("gpt-6-luna", "GPT-6 Luna")] }),
      { setup: setup(true, true) }),
    e("claudeAgent", "claudeAgent", probe(at, { installed: true, version: "2.1.332", cli: "present", status: "warning",
      auth: { status: "unauthenticated" }, message: "Not signed in",
      models: [model("claude-opus-5-5", "Claude Opus 5.5", true), model("claude-sonnet-5-5", "Claude Sonnet 5.5"), model("claude-haiku-5-5", "Claude Haiku 5.5")] }),
      { setup: setup(true, true) }),
    e("grok", "grok", probe(at, { installed: false, cli: "missing", status: "error", message: "grok was not found on PATH" }), { setup: setup(true, true) }),
    e("fx", "fx", probe(at, { installed: false, cli: "missing", status: "error", message: "fx was not found on PATH" }), { setup: setup(true, true) }),
    e("antigravity", "antigravity", probe(at, { installed: true, version: "1.4.2", cli: "present", status: "warning",
      auth: { status: "unauthenticated", action: { elicitationId: "agy-signin-1", url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=antigravity-demo", message: "Sign in with Google to see Antigravity limits." } },
      message: "Sign in with Google to see Antigravity limits.", models: [model("antigravity-default", "Antigravity default", true)] }),
      { setup: setup(true, false) }),
    e("opencode", "opencode", probe(at, { installed: true, version: "1.19.4", cli: "present", status: "ready", auth: { status: "authenticated", label: "3 providers" },
      models: [model("openai/gpt-5", "GPT-5 (OpenAI)", true), model("opencode/big-pickle", "Big Pickle")] }), { setup: setup(true, true) }),
    e("cursor", "cursor", probe(at, { installed: true, version: null, status: "ready", auth: { status: "authenticated", label: "Cursor account", email: "you@example.com" },
      models: [model("auto", "Auto", true), model("composer-2", "Composer 2")] }), { setup: setup(true, false) }),
    e("muse", "muse", probe(at, { installed: false, cli: "missing", status: "error", message: "Muse is not installed" }), { setup: setup(true, true) }),
    e("pi", "pi", probe(at, { installed: true, version: "0.42.0", cli: "present", status: "ready", auth: { status: "authenticated" },
      models: [model("default", "Pi settings model", true)] }), { setup: setup(false, true) }),
    e("omo", "omo", probe(at, { installed: true, version: "0.42.0", cli: "present", status: "error", auth: { status: "unknown" },
      message: "Runtime target missing. Reinstall to repair." }), { setup: setup(false, true) }),
    e("acp-kimi-code", "acpRegistry", probe(at, { installed: true, version: "2.8.1", status: "ready", auth: { status: "authenticated" },
      models: [model("default", "Kimi default", true)] }), { displayName: "Kimi Code", acpAgentId: "kimi-code", setup: setup(true, true), authFlow: agentAuth("acp-kimi-code") }),
    e("acp-kilo", "acpRegistry", probe(at, { installed: true, version: "7.8.31", status: "warning", auth: { status: "authenticated" },
      models: [model("default", "Kilo default", true)], message: "Updating to 7.8.32" }),
      { displayName: "Kilo", acpAgentId: "kilo", setup: setup(true, true), authFlow: agentAuth("acp-kilo"),
        install: { driver: "acpRegistry", operationId: "install-kilo", phase: "downloading", downloadedBytes: 31_000_000, totalBytes: 50_000_000, version: "7.8.32", installedVersion: "7.8.31", canRemove: false, message: null } }),
  ];
}

const agent = (id: string, name: string, version: string, description: string, distribution: "binary" | "npx" | "uvx"): AcpRegistrySearchAgent =>
  ({ id, name, version, description, authors: [], license: null, website: null, repository: null,
    icon: `https://cdn.agentclientprotocol.com/registry/v1/latest/${id}.svg`, distribution, integrity: "registry" });

/** Board 1QAN-2 rows; ids, versions and distributions as in the live index (cdn.agentclientprotocol.com/registry/v1/latest/registry.json, 2026-11-29). */
export const DEMO_REGISTRY: AcpRegistrySearchAgent[] = [
  agent("kimi-code", "Kimi Code", "2.8.1", "Moonshot AI's next-gen coding agent", "npx"),
  agent("kilo", "Kilo", "7.8.32", "The open source coding agent", "binary"),
  agent("kiro", "Kiro CLI", "3.6.2", "The Kiro coding agent", "binary"),
  agent("qwen-code", "Qwen Code", "0.28.7", "Alibaba's Qwen coding assistant", "npx"),
];

export interface FakeProvidersOptions { now?: () => string; stepMs?: number }

export class FakeProviders {
  readonly entries: ServerProviderEntry[];
  readonly registry: AcpRegistrySearchAgent[];
  private listeners = new Set<(list: ServerProviderEntry[]) => void>();
  private readonly now: () => string;
  private readonly stepMs: number;
  private seq = 0;

  constructor(entries: ServerProviderEntry[], registry: AcpRegistrySearchAgent[] = DEMO_REGISTRY, opts: FakeProvidersOptions = {}) {
    this.entries = entries;
    this.registry = registry;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.stepMs = opts.stepMs ?? 400;
  }

  /** The fake host forwards each providers subscription here. */
  onList(cb: (list: ServerProviderEntry[]) => void): () => void {
    this.listeners.add(cb);
    cb(this.list());
    return () => { this.listeners.delete(cb); };
  }
  private list() { return this.entries.map((e) => ({ ...e })); }
  private changed() { const l = this.list(); for (const cb of this.listeners) cb(l); }
  private entry(instanceId: string) { return this.entries.find((e) => e.instanceId === instanceId); }
  private replace(next: ServerProviderEntry) {
    const i = this.entries.findIndex((e) => e.instanceId === next.instanceId);
    if (i >= 0) this.entries[i] = next; else this.entries.push(next);
    this.changed();
  }
  private missing(instanceId: string): ProviderCommandOutcome {
    return { ok: false, error: { code: "not_found", reason: "provider_not_found", message: `No provider instance ${instanceId}.`, retryable: false } };
  }

  /** Answers a provider command, or null when the frame is not one. */
  run(body: { type: string } & Record<string, unknown>): ProviderCommandOutcome | null {
    const f = body as ProviderCommandBody;
    switch (f.type) {
      case "refresh_providers": {
        const at = this.now();
        for (const e of this.entries) if (!f.instanceId || e.instanceId === f.instanceId) e.probe = { ...e.probe, checkedAt: at };
        this.changed();
        return { ok: true, value: {} };
      }
      case "provider_install_start": {
        const e = this.entry(f.instanceId);
        if (!e) return this.missing(f.instanceId);
        if (e.setup && !e.setup.canInstall) return { ok: false, error: { code: "failed_precondition", reason: "install_unsupported", message: "This provider cannot be installed from GOAT.", retryable: false } };
        const state: ProviderInstallState = { driver: e.driver, operationId: `install-${++this.seq}`, phase: "downloading", downloadedBytes: 0, totalBytes: 40_000_000, version: e.probe.version ?? "1.0.0", installedVersion: e.probe.installed ? e.probe.version : null, canRemove: false, message: null };
        this.replace({ ...e, install: state });
        this.stepInstall(e.instanceId, state.operationId!, 0);
        return { ok: true, value: { installState: state } };
      }
      case "provider_install_cancel": {
        const e = this.entry(f.instanceId);
        if (!e) return this.missing(f.instanceId);
        const state: ProviderInstallState = { ...(e.install ?? idleInstallFor(e.driver)), phase: "cancelled", message: "Install cancelled." };
        this.replace({ ...e, install: state });
        return { ok: true, value: { installState: state } };
      }
      case "provider_auth_start": {
        const e = this.entry(f.instanceId);
        if (!e) return this.missing(f.instanceId);
        const url = e.probe.auth.action?.url ?? `https://example.com/${e.driver}/sign-in?demo=1`;
        const state: ProviderAuthState = { instanceId: e.instanceId, phase: "waiting", flowId: `auth-${++this.seq}`, authorizationUrl: url, expiresAt: null, message: e.probe.auth.action?.message ?? null,
          interaction: { type: "browser", id: `interaction-${this.seq}`, url, requiresConsent: false } };
        this.replace({ ...e, authFlow: state });
        return { ok: true, value: { authState: state } };
      }
      case "provider_auth_cancel": {
        const e = this.entry(f.instanceId);
        if (!e) return this.missing(f.instanceId);
        const state: ProviderAuthState = { instanceId: e.instanceId, phase: "cancelled", flowId: f.flowId, authorizationUrl: null, expiresAt: null, message: null };
        this.replace({ ...e, authFlow: state });
        return { ok: true, value: { authState: state } };
      }
      case "provider_auth_logout": {
        const e = this.entry(f.instanceId);
        if (!e) return this.missing(f.instanceId);
        const state: ProviderAuthState = { instanceId: e.instanceId, phase: "idle", flowId: null, authorizationUrl: null, expiresAt: null, message: null };
        const { authFlow: _drop, ...rest } = e;
        this.replace({ ...rest, probe: { ...e.probe, status: "warning", auth: { status: "unauthenticated" }, message: "Not signed in" } });
        return { ok: true, value: { authState: state } };
      }
      case "accept_acp_registry_url_auth": {
        const e = this.entry(f.instanceId);
        if (!e) return this.missing(f.instanceId);
        const accepted = e.probe.auth.action?.elicitationId === f.elicitationId;
        if (accepted) this.run({ type: "provider_auth_start", instanceId: f.instanceId });
        return { ok: true, value: { accepted } };
      }
      case "search_acp_registry": {
        const q = f.query.trim().toLowerCase();
        const agents = this.registry.filter((a) => !q || [a.id, a.name, a.description].some((s) => s.toLowerCase().includes(q)));
        return { ok: true, value: { registrySearch: { agents: agents.slice(0, f.limit ?? agents.length) } } };
      }
      case "prepare_acp_registry_agent": {
        const a = this.registry.find((x) => x.id === f.agentId);
        if (!a) return { ok: false, error: { code: "not_found", reason: "agent_not_found", message: `${f.agentId} is not in the ACP registry.`, retryable: false } };
        return { ok: true, value: { registryPrepare: { agentId: a.id, version: a.version, distribution: a.distribution, prepared: true } } };
      }
      case "set_provider_instance": {
        const prev = this.entry(f.instanceId);
        const a = f.acpAgentId ? this.registry.find((x) => x.id === f.acpAgentId) : undefined;
        if (f.acpAgentId && !a && !prev) return { ok: false, error: { code: "not_found", reason: "agent_not_found", message: `${f.acpAgentId} is not in the ACP registry.`, retryable: false } };
        const base: ServerProviderEntry = prev ?? {
          instanceId: f.instanceId, driver: f.driver, enabled: f.enabled, capabilities: CAPABILITIES as ProviderCapabilities, setup: setup(true, true),
          probe: probe(this.now(), { installed: true, version: a?.version ?? null, status: "warning", auth: { status: "unauthenticated" },
            models: [model("default", `${a?.name ?? f.driver} default`, true)], message: "Not signed in" }),
          ...(f.driver === "acpRegistry" ? { authFlow: agentAuth(f.instanceId) } : {}),
        };
        this.replace({ ...base, driver: f.driver, enabled: f.enabled, ...(f.displayName ? { displayName: f.displayName } : {}), ...(f.acpAgentId ? { acpAgentId: f.acpAgentId } : {}) });
        return { ok: true, value: {} };
      }
      default:
        return null;
    }
  }

  /** A demo sign-in finishing in the browser: the flow succeeds and the probe reports the account. */
  completeAuth(instanceId: string, email = "you@example.com") {
    const e = this.entry(instanceId);
    if (!e) return;
    const flow = e.authFlow;
    const { message: _signedOutMessage, ...probeRest } = e.probe;
    this.replace({
      ...e,
      authFlow: { instanceId, phase: "succeeded", flowId: flow?.flowId ?? null, authorizationUrl: null, expiresAt: null, message: null },
      probe: { ...probeRest, status: "ready", auth: { status: "authenticated", email, canLogout: true }, checkedAt: this.now() },
    });
  }

  private stepInstall(instanceId: string, operationId: string, step: number) {
    setTimeout(() => {
      const e = this.entry(instanceId);
      if (!e?.install || e.install.operationId !== operationId || e.install.phase === "cancelled") return;
      const total = e.install.totalBytes ?? 1;
      if (step < 2) {
        this.replace({ ...e, install: { ...e.install, downloadedBytes: Math.round(total * (step + 1) / 3) } });
        return this.stepInstall(instanceId, operationId, step + 1);
      }
      if (step === 2) {
        this.replace({ ...e, install: { ...e.install, phase: "verifying", downloadedBytes: total } });
        return this.stepInstall(instanceId, operationId, step + 1);
      }
      const version = e.install.version;
      const signedIn = e.probe.auth.status === "authenticated";
      const { message: _oldMessage, ...probeRest } = e.probe;
      this.replace({
        ...e,
        install: { ...e.install, phase: "succeeded", installedVersion: version },
        probe: { ...probeRest, installed: true, version, cli: "present", checkedAt: this.now(),
          status: signedIn ? "ready" : "warning",
          auth: e.probe.auth.status === "unknown" ? { status: "unauthenticated" } : e.probe.auth,
          ...(signedIn ? {} : { message: "Not signed in" }) },
      });
    }, this.stepMs);
  }
}

function idleInstallFor(driver: string): ProviderInstallState {
  return { driver, operationId: null, phase: "idle", downloadedBytes: 0, totalBytes: null, version: null, installedVersion: null, canRemove: false, message: null };
}

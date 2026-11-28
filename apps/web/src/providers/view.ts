// The provider screens' view of the host's provider list (boards 1PBB-2, 1Q0P-2, 1QAN-2, 2LEU-2, 2LEV-2): which
// providers are added, each one's state line and dot, the catalog and the first-run list. Pure, so it is tested
// without React. Inputs are the approved wire entries (docs/part2/provider-wire.md).
import type { AcpRegistrySearchAgent, ServerProviderEntry } from "./wire.ts";
import { CLOUD, DRIVERS, PRESETS, driverLabel } from "./catalogMeta.ts";

/** Board colours: green ready, blue needs you, red broken, amber update; grey for off or unknown. */
export type Dot = "green" | "blue" | "red" | "amber" | "grey";
export const DOT_COLOR: Record<Dot, string> = { green: "#1F9D55", blue: "#2F6FED", red: "#D83A3A", amber: "#C27A0E", grey: "#B4B4B4" };

export type Need = "none" | "sign-in" | "install" | "repair" | "unknown";
export interface ProviderState { dot: Dot; word: string; need: Need; busy: "installing" | "signing-in" | null }

const INSTALLING = new Set(["downloading", "extracting", "verifying"]);
const SIGNING_IN = new Set(["starting", "waiting", "verifying"]);

/** Placeholder rows the seam adds for drivers this host build lacks (seam/goat2/providerPort.ts unservedPlaceholders). */
export const isUnserved = (e: ServerProviderEntry) => !e.enabled && e.probe.status === "disabled" && /does not include|later GOAT 2 release/.test(e.probe.message ?? "");

export function providerState(e: ServerProviderEntry): ProviderState {
  if (e.install && INSTALLING.has(e.install.phase)) {
    const pct = e.install.totalBytes ? Math.round((e.install.downloadedBytes / e.install.totalBytes) * 100) : null;
    return { dot: "blue", word: pct === null ? "Installing" : `Installing \u00b7 ${pct}%`, need: "none", busy: "installing" };
  }
  if (!e.enabled) return { dot: "grey", word: "Off", need: "none", busy: null };
  if (e.authFlow && SIGNING_IN.has(e.authFlow.phase)) return { dot: "blue", word: "Signing in", need: "sign-in", busy: "signing-in" };
  const p = e.probe;
  if (!p.installed || p.cli === "missing") {
    return e.setup?.canInstall ? { dot: "blue", word: "Not installed", need: "install", busy: null } : { dot: "red", word: "Not found on this Mac", need: "install", busy: null };
  }
  if (p.status === "error") return { dot: "red", word: "Needs repair", need: "repair", busy: null };
  if (p.auth.status === "unauthenticated" || p.auth.action) return { dot: "blue", word: "Needs sign-in", need: "sign-in", busy: null };
  if (p.status === "ready") return { dot: "green", word: "Ready", need: "none", busy: null };
  if (p.status === "disabled") return { dot: "grey", word: "Unavailable", need: "unknown", busy: null };
  return { dot: "grey", word: "Status unknown", need: "unknown", busy: null };
}

/** "Codex", or "Codex" with the account label the person gave it ("Personal"); registry agents use their name. */
export function titleParts(e: ServerProviderEntry): { name: string; account: string | null } {
  if (e.driver === "acpRegistry") return { name: e.displayName ?? e.acpAgentId ?? e.instanceId, account: null };
  return { name: driverLabel(e.driver), account: e.displayName ?? null };
}
export const title = (e: ServerProviderEntry) => { const t = titleParts(e); return t.account ? `${t.name} \u00b7 ${t.account}` : t.name; };

/** Sidebar line: the state word, then what helps tell rows apart (plan, model sources). */
export function rowLine(e: ServerProviderEntry): string {
  const s = providerState(e);
  const extra = s.word === "Ready" ? e.probe.auth.label : undefined;
  return extra ? `${s.word} \u00b7 ${extra}` : s.word;
}

/** Detail header line: state, version, when it was checked. */
export function headerLine(e: ServerProviderEntry, now: number): string {
  const s = providerState(e);
  const parts = [s.word];
  if (e.probe.version) parts.push(`v${e.probe.version}`);
  parts.push(`checked ${ago(e.probe.checkedAt, now)}`);
  return parts.join(" \u00b7 ");
}


export function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(s) || s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

/** Masked account email as the boards show it (y\u2022\u2022\u2022@example.com). */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  return at <= 0 ? email : `${email[0]}\u2022\u2022\u2022${email.slice(at)}`;
}

/**
 * Added = the person uses it: switched on, or configured (named, a registry agent), or switched off from its detail
 * page (kept in ui-state so it stays listed). Everything else lives in the catalog (principle 7).
 */
export function isAdded(e: ServerProviderEntry, keptOff: ReadonlyArray<string>): boolean {
  if (isUnserved(e)) return false;
  return e.enabled || e.acpAgentId !== undefined || e.displayName !== undefined || keptOff.includes(e.instanceId);
}

/** Sidebar order of board 1PBB-2. */
const KIND_ORDER = ["codex", "claudeAgent", "cursor", "opencode", "antigravity", "pi", "omo", "muse", "grok", "fx", "acpRegistry"];

/** The mark of an entry: the driver's, or a registry agent's icon from the registry CDN (v1 acpRegistry.ts icon URL). */
export const iconOf = (e: ServerProviderEntry): { driver: string } | { url: string } =>
  e.acpAgentId ? { url: `https://cdn.agentclientprotocol.com/registry/v1/latest/${e.acpAgentId}.svg` } : { driver: e.driver };
export function addedProviders(entries: ReadonlyArray<ServerProviderEntry>, keptOff: ReadonlyArray<string>): ServerProviderEntry[] {
  const rank = (e: ServerProviderEntry) => { const i = KIND_ORDER.indexOf(e.driver); return i < 0 ? KIND_ORDER.length : i; };
  return entries.map((e, i) => ({ e, i })).filter(({ e }) => isAdded(e, keptOff))
    .sort((a, b) => rank(a.e) - rank(b.e) || a.i - b.i).map(({ e }) => e);
}

export function matches(e: ServerProviderEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || [title(e), e.driver, e.probe.auth.label ?? "", e.probe.auth.email ?? ""].some((s) => s.toLowerCase().includes(q));
}

// ---------------------------------------------------------------- catalog (board 1QAN-2)

export type CatalogFilter = "all" | "ready" | "cloud";
export type CatalogAction =
  | { kind: "enable"; instanceId: string; driver: string }
  | { kind: "install"; instanceId: string; driver: string }
  | { kind: "registry"; agentId: string; name: string }
  | { kind: "copy"; text: string; docsUrl: string }
  | { kind: "none"; reason: string };
export interface CatalogItem {
  key: string; name: string; blurb: string; badge: string; section: "mac" | "more";
  icon: { driver: string } | { url: string }; action: CatalogAction; cloud: boolean; installed: boolean;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function catalog(entries: ReadonlyArray<ServerProviderEntry>, keptOff: ReadonlyArray<string>,
  registry: ReadonlyArray<AcpRegistrySearchAgent>, filter: CatalogFilter, query: string): CatalogItem[] {
  const added = addedProviders(entries, keptOff);
  const items: CatalogItem[] = [];
  const kinds = new Set<string>();
  for (const e of entries) {
    if (e.driver === "acpRegistry" || CLOUD[e.driver] || kinds.has(e.driver)) continue;
    kinds.add(e.driver);
    const mine = added.filter((a) => a.driver === e.driver);
    const base = entries.find((x) => x.driver === e.driver && x.instanceId === e.driver) ?? e;
    const meta = DRIVERS[e.driver];
    const name = driverLabel(e.driver);
    const blurb = meta?.blurb ?? "";
    const installed = base.probe.installed && base.probe.cli !== "missing";
    if (mine.length > 0) {
      items.push({ key: e.driver, name, blurb: mine.length > 1 ? `Already added: ${plural(mine.length, "account")}.` : "Already added.", badge: "Added",
        section: "mac", icon: { driver: e.driver }, action: { kind: "none", reason: "" }, cloud: false, installed: true });
    } else if (isUnserved(base)) {
      items.push({ key: e.driver, name, blurb, badge: "Not in this build", section: "more", icon: { driver: e.driver },
        action: { kind: "none", reason: base.probe.message ?? "" }, cloud: false, installed: false });
    } else if (installed) {
      items.push({ key: e.driver, name, blurb, badge: "Installed", section: "mac", icon: { driver: e.driver },
        action: { kind: "enable", instanceId: base.instanceId, driver: e.driver }, cloud: false, installed: true });
    } else if (base.setup?.canInstall) {
      items.push({ key: e.driver, name, blurb, badge: "1-click install", section: "more", icon: { driver: e.driver },
        action: { kind: "install", instanceId: base.instanceId, driver: e.driver }, cloud: false, installed: false });
    } else {
      items.push({ key: e.driver, name, blurb, badge: "Not installed", section: "more", icon: { driver: e.driver },
        action: { kind: "none", reason: `Install ${name} on this Mac, then refresh.` }, cloud: false, installed: false });
    }
  }
  for (const p of PRESETS) {
    items.push({ key: `preset:${p.id}`, name: p.label, blurb: `Install it with one command, then add it as a custom agent.`, badge: "Install command",
      section: "more", icon: { url: p.iconUrl }, action: { kind: "copy", text: p.installHint, docsUrl: p.docsUrl }, cloud: false, installed: false });
  }
  for (const a of registry) {
    const have = entries.some((e) => e.acpAgentId === a.id && isAdded(e, keptOff));
    items.push({ key: `acp:${a.id}`, name: a.name, blurb: a.description, badge: have ? "Added" : "1-click install",
      section: have ? "mac" : "more", icon: a.icon ? { url: a.icon } : { driver: "acpRegistry" },
      action: have ? { kind: "none", reason: "" } : { kind: "registry", agentId: a.id, name: a.name }, cloud: false, installed: have });
  }
  for (const [driver, c] of Object.entries(CLOUD)) {
    if (!c.platform && filter !== "cloud") continue; // counterparts live on their local provider (principle 9)
    items.push({ key: driver, name: c.label, blurb: c.blurb, badge: "Cloud", section: "more", icon: { driver },
      action: { kind: "none", reason: "Cloud runs come in a later GOAT 2 release." }, cloud: true, installed: false });
  }
  const q = query.trim().toLowerCase();
  return items.filter((i) => (filter === "all" || (filter === "ready" ? i.installed : i.cloud))
    && (!q || `${i.name} ${i.blurb}`.toLowerCase().includes(q)))
    .sort((a, b) => (a.section === b.section ? Number(a.badge === "Added") - Number(b.badge === "Added") : a.section === "mac" ? -1 : 1));
}

/** First run (board 2LEV-2): providers found on this Mac that are not added yet. */
export function detected(entries: ReadonlyArray<ServerProviderEntry>, keptOff: ReadonlyArray<string>): ServerProviderEntry[] {
  return entries.filter((e) => e.driver !== "acpRegistry" && !CLOUD[e.driver] && !isAdded(e, keptOff) && !isUnserved(e)
    && e.probe.installed && e.probe.cli !== "missing" && e.instanceId === e.driver);
}

export function detectedLine(e: ServerProviderEntry): string {
  const a = e.probe.auth;
  if (a.status === "authenticated") return a.email ? `Installed \u00b7 signed in as ${maskEmail(a.email)}` : "Installed \u00b7 signed in";
  if (a.status === "unauthenticated") return "Installed \u00b7 needs sign-in";
  return "Installed";
}

/** The next free instance id for another account of a driver: codex-2, codex-3, ... */
export function nextInstanceId(entries: ReadonlyArray<ServerProviderEntry>, driver: string): string {
  for (let n = 2; ; n++) if (!entries.some((e) => e.instanceId === `${driver}-${n}`)) return `${driver}-${n}`;
}


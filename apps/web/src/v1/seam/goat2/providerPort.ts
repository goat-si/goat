// GOAT 2 seam: the one place provider data enters the lifted v1 provider screens (P2-M).
//
// The lifted v1 code reads providers through v1 atoms (state/server.ts serverEnvironment.*) and calls v1 WS methods.
// The GOAT 2 app installs a ProviderPort that answers those methods from the GOAT 2 host (or the fake host scene) and
// pushes provider entries; this file turns entries into v1 ServerProvider values (decoded with the lifted v1 schema,
// so a malformed host value fails here, visibly) and owns the atoms the seam modules share.
import {
  ServerProvider,
  type ServerProvider as ServerProviderType,
  type ServerSettings,
  DEFAULT_SERVER_SETTINGS,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";
import type { ProviderPortMethod, ProviderPortStream } from "./surfaces.types.ts";

/** GOAT 2 ProviderProbeResult (crates/goat2-contracts/src/probe.rs on goat2_contracts); v1 ServerProvider subset. */
export interface Goat2ProviderProbe {
  readonly installed: boolean;
  readonly version: string | null;
  readonly installedVersion?: string | null;
  readonly cli?: "present" | "missing" | "none";
  readonly binaryPath?: string;
  readonly status: "ready" | "warning" | "error" | "disabled";
  readonly auth: {
    readonly status: "authenticated" | "unauthenticated" | "unknown";
    readonly type?: string;
    readonly label?: string;
    readonly email?: string;
    readonly action?: {
      readonly elicitationId: string;
      readonly url: string;
      readonly message: string;
      readonly createdAt?: string;
      readonly expiresAt?: string;
    };
    readonly canLogout?: boolean;
  };
  readonly models: ReadonlyArray<{
    readonly slug: string;
    readonly name: string;
    readonly shortName?: string;
    readonly subProvider?: string;
    readonly isCustom: boolean;
    readonly isDefault?: boolean;
    readonly capabilities: unknown;
  }>;
  readonly checkedAt: string;
  readonly message?: string;
}

/** One provider instance as the GOAT 2 host reports it (P2-M wire proposal: providers frame entry). */
export interface Goat2ProviderEntry {
  readonly instanceId: string;
  readonly driver: string;
  readonly displayName?: string;
  readonly enabled: boolean;
  readonly acpAgentId?: string;
  readonly badgeLabel?: string;
  readonly setup?: { readonly canAuthenticate: boolean; readonly canInstall: boolean; readonly documentationUrl?: string };
  readonly probe: Goat2ProviderProbe;
  /** Running sign-in / install flow (wire ServerProviderEntry.authFlow / .install); read by the port's watch streams. */
  readonly authFlow?: unknown;
  readonly install?: unknown;
}

/** v1 WS method names the lifted provider screens call (packages/contracts/src/rpc.ts WS_METHODS) plus
 * goat2.setProviderInstance; one definition, shared with GOAT 2 code through surfaces.types.ts. */
export type Goat2ProviderMethod = ProviderPortMethod;
export type Goat2ProviderStream = ProviderPortStream;

export interface ProviderPort {
  /** Calls listener with the full provider list now (if known) and on every change. */
  readonly subscribe: (listener: (entries: ReadonlyArray<Goat2ProviderEntry>) => void) => () => void;
  /** Answers a v1 method; rejects with an Error whose message is shown to the person. */
  readonly call: (method: Goat2ProviderMethod, payload: unknown) => Promise<unknown>;
  /** Streams a v1 subscription's values (auth flow, install progress). */
  readonly watch: (method: Goat2ProviderStream, payload: unknown, listener: (value: unknown) => void) => () => void;
}

let port: ProviderPort | null = null;
const portListeners = new Set<() => void>();

/** The GOAT 2 app calls this once its host (or the fake host scene) is ready. */
export function installProviderPort(next: ProviderPort | null): void {
  port = next;
  for (const listener of portListeners) listener();
}

export function currentProviderPort(): ProviderPort {
  if (!port) throw new Error("GOAT is not connected to its host yet.");
  return port;
}

export function onProviderPortChange(listener: () => void): () => void {
  portListeners.add(listener);
  return () => portListeners.delete(listener);
}

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);

/** v1 ServerProvider from a GOAT 2 entry; fields v1 has and GOAT 2 does not stay at their v1 defaults. */
export function toServerProvider(entry: Goat2ProviderEntry): ServerProviderType {
  const { probe } = entry;
  return decodeServerProvider({
    executionLocation: "local",
    instanceId: entry.instanceId,
    driver: entry.driver,
    ...(entry.displayName ? { displayName: entry.displayName } : {}),
    ...(entry.badgeLabel ? { badgeLabel: entry.badgeLabel } : {}),
    ...(entry.setup ? { setup: entry.setup } : {}),
    enabled: entry.enabled,
    installed: probe.installed,
    version: probe.version,
    ...(probe.installedVersion !== undefined ? { installedVersion: probe.installedVersion } : {}),
    status: probe.status,
    auth: probe.auth,
    checkedAt: probe.checkedAt,
    ...(probe.message ? { message: probe.message } : {}),
    ...(probe.cli ? { cli: probe.cli, cliCheckedAt: probe.checkedAt } : {}),
    models: probe.models,
    slashCommands: [],
    skills: [],
  });
}

/** The host's provider list as v1 ServerProviders; null until the first list arrives. */
export const goat2ProvidersAtom: Atom.Atom<ReadonlyArray<ServerProviderType> | null> = Atom.make(
  (get): ReadonlyArray<ServerProviderType> | null => {
    let unsubscribe = () => {};
    const attach = () => {
      unsubscribe();
      unsubscribe = port
        ? port.subscribe((entries) =>
            get.setSelf<ReadonlyArray<ServerProviderType> | null>(entries.map(toServerProvider)),
          )
        : () => {};
    };
    const stop = onProviderPortChange(attach);
    attach();
    get.addFinalizer(() => {
      stop();
      unsubscribe();
    });
    return null;
  },
).pipe(Atom.keepAlive, Atom.withLabel("goat2:providers"));

/** Server settings the provider screens read and write (favorites, provider instances). */
export const goat2SettingsAtom: Atom.Writable<ServerSettings, ServerSettings> = Atom.make<ServerSettings>(
  DEFAULT_SERVER_SETTINGS,
).pipe(Atom.keepAlive, Atom.withLabel("goat2:server-settings"));

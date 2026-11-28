// The typed boundary between GOAT 2 code and the lifted v1 tree (@v1/surfaces). GOAT 2's tsconfig resolves @v1/surfaces
// to this file, so its typecheck never walks v1 internals (v1 needs its own compiler options); vite resolves it to
// surfaces.ts, and tsconfig.v1.json checks that surfaces.ts implements exactly these declarations. Declarations only,
// valid under both compiler setups.
import type { ComponentType, HTMLAttributes } from "react";

/** The [data-v1] boundary a lifted v1 surface renders inside (v1 CSS is scoped to it). */
export declare const V1Boundary: ComponentType<HTMLAttributes<HTMLDivElement>>;
/** ?v1fixture: CSS scoping and portal-root check (e2e/v1fixture.spec.ts). */
export declare const V1Fixture: ComponentType;

/** v1 method names the lifted provider screens call; GOAT 2's adapter (apps/web/src/providers/hostProviderPort.ts)
 * answers each with a provider frame (docs/part2/provider-wire.md) or refuses it. */
export type ProviderPortMethod =
  | "server.refreshProviders"
  | "server.updateProvider"
  | "server.searchAcpRegistry"
  | "server.prepareAcpRegistryAgent"
  | "server.uninstallAcpRegistryManagedBinary"
  | "server.acceptAcpRegistryUrlAuth"
  | "goat2.setProviderInstance"
  | "providerInstall.start"
  | "providerInstall.cancel"
  | "providerInstall.remove"
  | "providerAuth.start"
  | "providerAuth.respond"
  | "providerAuth.complete"
  | "providerAuth.cancel"
  | "providerAuth.logout";
export type ProviderPortStream = "providerAuth.subscribe" | "providerInstall.subscribe";

/** One providers-frame entry as the port hands it to the v1 screens (wire ServerProviderEntry). */
export interface ProviderPortEntry {
  readonly instanceId: string;
  readonly driver: string;
  readonly displayName?: string;
  readonly enabled: boolean;
  readonly acpAgentId?: string;
  readonly setup?: { readonly canAuthenticate: boolean; readonly canInstall: boolean; readonly documentationUrl?: string };
  readonly probe: unknown;
  readonly authFlow?: unknown;
  readonly install?: unknown;
}

export interface ProviderPortShape {
  /** Full provider list now (if known) and on every change. */
  readonly subscribe: (listener: (entries: ReadonlyArray<ProviderPortEntry>) => void) => () => void;
  /** Answers a v1 method; rejects with an Error whose message is shown to the person. */
  readonly call: (method: ProviderPortMethod, payload: unknown) => Promise<unknown>;
  /** A v1 subscription's values (sign-in flow, install progress). */
  readonly watch: (method: ProviderPortStream, payload: unknown, listener: (value: unknown) => void) => () => void;
}

/** Installs (or with null removes) the port the lifted provider screens read through. */
export declare const installProviderPort: (port: ProviderPortShape | null) => void;

/** Settings > Providers (v1 ProviderSettingsPanel for GOAT 2's environment); instanceId focuses one provider. */
export declare const ProvidersSettingsScreen: ComponentType<{ instanceId?: string }>;

/** Where the GOAT 2 frame is, for v1 code that reads its router location (settings paths, ?instanceId=). */
export interface V1Location { readonly pathname: string; readonly hash?: string; readonly search?: Readonly<Record<string, unknown>> }
export declare const setV1Location: (location: V1Location) => void;
/** How v1 code moves: the GOAT 2 frame receives the resolved target (v1 useNavigate / Link). */
export declare const setV1Navigator: (navigate: (to: Required<V1Location>) => void) => void;

/** v1's ProviderModelPicker (trigger + popup) over the host's providers; GOAT 2 decides where the choice goes. */
export interface ModelPickerProps {
  instanceId: string;
  model: string;
  onChange: (selection: { instanceId: string; model: string }) => void;
  composer?: boolean;
  popupAlign?: "start" | "end";
  ariaLabel?: string;
  disabled?: boolean;
}
export declare const ModelPicker: ComponentType<ModelPickerProps>;
/** Settings > bot: the Model row (board 1QYE-2). onChange null until the bot has a thread. */
export declare const BotModelSettings: ComponentType<{
  botName: string;
  instanceId: string;
  model: string;
  onChange: ((selection: { instanceId: string; model: string }) => void) | null;
}>;

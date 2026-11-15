import type { ProviderInstanceEnvironment, ProviderInstanceId } from "@goat/contracts";
import { mergeProviderInstanceEnvironment } from "@goat/provider-core/server/instanceEnvironment";
import * as Effect from "effect/Effect";

import { exchangesAtCursor } from "./apiKey.ts";
import { instanceCredentials } from "./credentialScope.ts";
import { readStoredCursorSignIn } from "./credentialStore.ts";

/** One Cursor instance as the server settings describe it, for the account scan. */
export interface ScanInstance {
  readonly instanceId: ProviderInstanceId;
  /** The instance's usage endpoint setting; undefined when its config cannot be decoded. */
  readonly config: { readonly apiEndpoint?: string | undefined } | undefined;
  /** The variables the instance sets itself. */
  readonly environment: ProviderInstanceEnvironment;
}

/** Why the scan leaves an instance out, as a person reads it. */
export const SCAN_EXCLUSIONS = {
  settings: "its settings cannot be read",
  backend: "its Cursor backend is not Cursor's",
  endpoint: "its usage endpoint is not Cursor's",
  inheritedKey: "it names its own usage endpoint but inherits the server's CURSOR_API_KEY",
  ownDestination:
    "it names its own Cursor backend or usage endpoint but has no credential of its own",
  signInBackend: "its GOAT sign-in belongs to another Cursor backend",
  signInExpired: "its GOAT sign-in has expired; sign in again",
  signInUnreadable: "its GOAT sign-in cannot be read; sign in again",
  token: "it has only CURSOR_AUTH_TOKEN, which account history cannot read",
} as const;

export type ScanExclusion = keyof typeof SCAN_EXCLUSIONS;

/** What an instance gives the scan: a key to read with, nothing at all, or a reason to leave it out. */
export type ScanCredential =
  | { readonly apiKey: string }
  | "none"
  | { readonly excluded: ScanExclusion };

/**
 * Decides one instance against `server`, the host copy the whole scan uses. Every read goes to
 * Cursor's exchange and usage service, so a credential is read only when its backend and usage
 * endpoint are Cursor's; precedence follows sessions: a key, then a GOAT sign-in.
 */
export const classifyScanInstance = Effect.fn("CursorUsageAccounts.classifyInstance")(function* (
  instance: ScanInstance,
  server: NodeJS.ProcessEnv,
) {
  const excluded = (reason: ScanExclusion): ScanCredential => ({ excluded: reason });
  if (instance.config === undefined) return excluded("settings");
  const scope = instanceCredentials({
    instanceVariables: new Set(instance.environment.map((variable) => variable.name)),
    settingsEndpoint: instance.config.apiEndpoint,
    environment: yield* mergeProviderInstanceEnvironment(instance.environment, server),
    server,
  });
  const environment = scope.environment;
  if (!exchangesAtCursor(environment.CURSOR_BACKEND_URL)) return excluded("backend");
  const endpoint =
    instance.config.apiEndpoint?.trim() || environment.CURSOR_API_ENDPOINT?.trim() || undefined;
  if (!exchangesAtCursor(endpoint)) return excluded("endpoint");
  const apiKey = environment.CURSOR_API_KEY?.trim();
  if (apiKey) return scope.usageTakesEnvironmentKey ? { apiKey } : excluded("inheritedKey");
  const signIn = yield* readStoredCursorSignIn(instance.instanceId).pipe(
    Effect.map((stored) => ({ stored })),
    // A record that cannot be read or decoded may name any account.
    Effect.orElseSucceed(() => "unreadable" as const),
  );
  if (signIn === "unreadable") return excluded("signInUnreadable");
  if (signIn.stored !== undefined) {
    if (!exchangesAtCursor(signIn.stored.backendUrl)) return excluded("signInBackend");
    if (signIn.stored.expired) return excluded("signInExpired");
    const storedKey = signIn.stored.apiKey.trim();
    return storedKey ? { apiKey: storedKey } : excluded("signInUnreadable");
  }
  if (environment.CURSOR_AUTH_TOKEN?.trim()) return excluded("token");
  return scope.serverLogins ? "none" : excluded("ownDestination");
});

/** The note naming every instance the scan left out, grouped by reason. */
export const scanExclusionNote = (
  decided: ReadonlyArray<readonly [ProviderInstanceId, ScanCredential]>,
) => {
  const byReason = new Map<ScanExclusion, Array<ProviderInstanceId>>();
  for (const [instanceId, credential] of decided) {
    if (typeof credential !== "object" || !("excluded" in credential)) continue;
    byReason.set(credential.excluded, [...(byReason.get(credential.excluded) ?? []), instanceId]);
  }
  if (byReason.size === 0) return undefined;
  const reasons = [...byReason].map(
    ([reason, instanceIds]) => instanceIds.join(", ") + ": " + SCAN_EXCLUSIONS[reason],
  );
  return "Cursor account history leaves out " + reasons.join("; ") + ".";
};

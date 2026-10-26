import type { DesktopCuaGrants } from "@goat/contracts";
import { COMPUTER_USE_HELPER_NAME } from "@goat/shared/cuaDriverRelease";
import * as Effect from "effect/Effect";

import { ComputerUseHelperError } from "./ComputerUseHelper.ts";

/** What a grant read answers; the driver's own read carries more for Windows readiness. */
export interface CuaGrantRead {
  readonly accessibility: boolean;
  readonly screenRecording: boolean;
}

/**
 * The app that must hold the macOS grants and how to read them now. Onboarding drags this app
 * into System Settings and polls it, so it can never name GOAT while a helper ships.
 */
export type CuaGrantTarget =
  | {
      readonly kind: "helper";
      readonly bundlePath: string;
      readonly name: string;
      readonly bundleId: string;
      readonly read: () => Promise<CuaGrantRead>;
    }
  | { readonly kind: "app"; readonly bundleId: string; readonly read: () => Promise<CuaGrantRead> }
  | { readonly kind: "unusable"; readonly message: string };

/** Helper failures that can pass on their own, so setup keeps asking instead of giving up. */
const TRANSIENT_HELPER_FAILURES: ReadonlySet<string> = new Set([
  "no_hello",
  "helper_exited",
  "timeout",
]);

/**
 * Picks the app that needs the grants from the engine the driver would run: the helper when one
 * ships, GOAT itself otherwise, and never GOAT in place of a helper that cannot run (a string).
 */
export function cuaGrantTarget(input: {
  readonly platform: NodeJS.Platform;
  readonly engine:
    | string
    | {
        readonly kind: "helper";
        readonly bundle: { readonly bundlePath: string; readonly bundleId: string };
      }
    | { readonly kind: "embedded" }
    | undefined;
  readonly appBundleId: string;
  readonly readHelper: () => Promise<CuaGrantRead>;
  readonly readApp: () => Promise<CuaGrantRead>;
}): CuaGrantTarget {
  if (input.platform !== "darwin")
    return {
      kind: "unusable",
      message: "Accessibility and Screen Recording are macOS permissions.",
    };
  if (typeof input.engine === "string") return { kind: "unusable", message: input.engine };
  if (input.engine?.kind === "helper")
    return {
      kind: "helper",
      bundlePath: input.engine.bundle.bundlePath,
      name: COMPUTER_USE_HELPER_NAME,
      bundleId: input.engine.bundle.bundleId,
      read: input.readHelper,
    };
  return { kind: "app", bundleId: input.appBundleId, read: input.readApp };
}

/** The target's grants without prompting; a helper that stays broken however often it is asked is unusable. */
export const readCuaGrants = Effect.fn("desktop.cua.grants")(function* (
  target: CuaGrantTarget,
  appName: string,
) {
  if (target.kind === "unusable")
    return { principal: "unusable", message: target.message } satisfies DesktopCuaGrants;
  const read = yield* Effect.tryPromise({
    try: target.read,
    // A reply that does not decode is a helper speaking another protocol, not a hiccup.
    catch: (cause) =>
      cause instanceof ComputerUseHelperError
        ? cause
        : new ComputerUseHelperError(
            "malformed_reply",
            "its answer about permissions could not be read.",
          ),
  }).pipe(
    Effect.map((value) => ({ ok: true as const, value })),
    // A helper that answers as another app, speaks another protocol, or refuses its parent
    // stays that way however often setup asks; only a slow or vanished helper is worth retrying.
    Effect.catchIf(
      (error) => !TRANSIENT_HELPER_FAILURES.has(error.code),
      (error) => Effect.succeed({ ok: false as const, message: error.message }),
    ),
  );
  if (!read.ok)
    return {
      principal: "unusable",
      message: `${COMPUTER_USE_HELPER_NAME} cannot be used: ${read.message}`,
    } satisfies DesktopCuaGrants;
  return {
    principal: target.kind,
    name: target.kind === "helper" ? target.name : appName,
    ...(target.kind === "helper" ? { bundlePath: target.bundlePath } : {}),
    bundleId: target.bundleId,
    accessibility: read.value.accessibility,
    screenRecording: read.value.screenRecording,
  } satisfies DesktopCuaGrants;
});

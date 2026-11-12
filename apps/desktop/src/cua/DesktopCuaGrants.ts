import type { CuaGrantReadFailure, DesktopCuaGrants } from "@goat/contracts";
import { COMPUTER_USE_HELPER_NAME } from "@goat/shared/cuaDriverRelease";
import * as Effect from "effect/Effect";

import { ComputerUseHelperError } from "./ComputerUseHelper.ts";
import type { CuaGrantReadEntry, CuaGrantReadLog, CuaGrantReadSubject } from "./cuaGrantReadLog.ts";

/** What a grant read answers; the driver's own read carries more for Windows readiness. */
export interface CuaGrantRead {
  readonly accessibility: boolean;
  readonly screenRecording: boolean;
}

/** Asks the app for its grants now, and logs what the read found when that changed. */
type ReadGrants = (read: "panel" | "setup") => Effect.Effect<CuaGrantRead, ComputerUseHelperError>;

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
      readonly read: ReadGrants;
    }
  | { readonly kind: "app"; readonly bundleId: string; readonly read: ReadGrants }
  | { readonly kind: "unusable"; readonly message: string };

/**
 * Helper failures that mean it gave no answer, which a later read may get. A helper that answers
 * as another app or speaks another protocol stays that way however often it is asked.
 */
const UNANSWERED: ReadonlyMap<string, CuaGrantReadFailure> = new Map([
  ["no_hello", "notStarted"],
  ["helper_exited", "stopped"],
  ["timeout", "tookTooLong"],
  ["untrusted_parent", "refused"],
]);

const UNANSWERED_WORDS: Readonly<Record<CuaGrantReadFailure, string>> = {
  notStarted: "it did not start",
  stopped: "it stopped before it answered",
  tookTooLong: "it took too long",
  refused: "it refused GOAT",
};

/** A reply that does not decode is a helper speaking another protocol, not a hiccup. */
const grantReadError = (cause: unknown) =>
  cause instanceof ComputerUseHelperError
    ? cause
    : new ComputerUseHelperError(
        "malformed_reply",
        "its answer about permissions could not be read.",
      );

/** What a failed read tells setup: no answer and why, or a helper that cannot be used at all. */
function unreadCuaGrants(error: ComputerUseHelperError) {
  const unanswered = UNANSWERED.get(error.code);
  return unanswered === undefined
    ? ({
        principal: "unusable",
        message: `${COMPUTER_USE_HELPER_NAME} cannot be used: ${error.message}`,
      } as const)
    : ({
        principal: "unusable",
        message: `${COMPUTER_USE_HELPER_NAME} did not answer: ${UNANSWERED_WORDS[unanswered]}.`,
        unanswered,
      } as const);
}

/**
 * The readiness check's grants step for a read that failed. It names why the read failed and
 * never a grant as off: macOS was not heard on that.
 */
function unreadGrantsStep(cause: unknown): {
  readonly code: string;
  readonly detail: string;
} {
  const error = grantReadError(cause);
  const unread = unreadCuaGrants(error);
  return {
    code: error.code,
    detail:
      unread.unanswered === undefined
        ? unread.message
        : `${unread.message} Its permissions could not be read, so this is not a missing permission. Try again.`,
  };
}

type UnreadGrants = ReturnType<typeof unreadGrantsStep>;
type GrantEngine =
  | {
      readonly kind: "helper";
      readonly bundle: { readonly bundlePath: string; readonly bundleId: string };
    }
  | { readonly kind: "embedded" };

/** The readiness check's own grant read: what macOS answered, or why the read failed. */
export const readGrantsForCheck = <Grants extends CuaGrantRead>(ask: () => Promise<Grants>) =>
  Effect.tryPromise({ try: ask, catch: unreadGrantsStep }).pipe(
    Effect.catch((unread) => Effect.succeed(unread)),
  );

/** The log entry for the readiness check's own grant read. */
export const checkedGrantRead = (
  engine: GrantEngine | undefined,
  appBundleId: string,
  read: CuaGrantRead | UnreadGrants,
): CuaGrantReadEntry => ({
  read: "verification",
  ...(engine?.kind === "helper"
    ? { bundlePath: engine.bundle.bundlePath, bundleId: engine.bundle.bundleId }
    : { bundleId: appBundleId }),
  ...("code" in read
    ? { error: read.code }
    : { accessibility: read.accessibility, screenRecording: read.screenRecording }),
});

/** Why the check's grants step fails: the read failed, or macOS answers that a grant is off. */
export function grantsStepFailure(
  read: (CuaGrantRead & { readonly detail?: string }) | UnreadGrants,
  principal: string,
): string | undefined {
  if ("code" in read) return read.detail;
  const missing = [
    ...(read.accessibility ? [] : ["Accessibility"]),
    ...(read.screenRecording ? [] : ["Screen Recording"]),
  ];
  return (
    read.detail ??
    (missing.length === 0
      ? undefined
      : `${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} off for ${principal}.`)
  );
}

/**
 * Picks the app that needs the grants from the engine the driver would run: the helper when one
 * ships, GOAT itself otherwise, and never GOAT in place of a helper that cannot run (a string).
 */
function cuaGrantTarget(input: {
  readonly platform: NodeJS.Platform;
  readonly engine: string | GrantEngine | undefined;
  readonly appBundleId: string;
  readonly readHelper: () => Promise<CuaGrantRead>;
  readonly readApp: () => Promise<CuaGrantRead>;
  readonly note: CuaGrantReadLog;
}): CuaGrantTarget {
  if (input.platform !== "darwin")
    return {
      kind: "unusable",
      message: "Accessibility and Screen Recording are macOS permissions.",
    };
  if (typeof input.engine === "string") return { kind: "unusable", message: input.engine };
  const reader =
    (subject: CuaGrantReadSubject, ask: () => Promise<CuaGrantRead>): ReadGrants =>
    (read) =>
      Effect.tryPromise({ try: ask, catch: grantReadError }).pipe(
        Effect.tap(({ accessibility, screenRecording }) =>
          input.note({ read, ...subject, accessibility, screenRecording }),
        ),
        Effect.tapError((error) => input.note({ read, ...subject, error: error.code })),
      );
  if (input.engine?.kind === "helper") {
    const { bundlePath, bundleId } = input.engine.bundle;
    return {
      kind: "helper",
      bundlePath,
      name: COMPUTER_USE_HELPER_NAME,
      bundleId,
      read: reader({ bundlePath, bundleId }, input.readHelper),
    };
  }
  return {
    kind: "app",
    bundleId: input.appBundleId,
    read: reader({ bundleId: input.appBundleId }, input.readApp),
  };
}

/**
 * The target's grants without prompting. A read that fails comes back as an unusable helper that
 * says why, with unanswered set when a later read may still get an answer.
 */
const readCuaGrants = Effect.fn("desktop.cua.grants")(function* (
  target: CuaGrantTarget,
  appName: string,
) {
  if (target.kind === "unusable")
    return { principal: "unusable", message: target.message } satisfies DesktopCuaGrants;
  return yield* target.read("setup").pipe(
    Effect.match({
      onFailure: (error): DesktopCuaGrants => unreadCuaGrants(error),
      onSuccess: (read): DesktopCuaGrants => ({
        principal: target.kind,
        name: target.kind === "helper" ? target.name : appName,
        ...(target.kind === "helper" ? { bundlePath: target.bundlePath } : {}),
        bundleId: target.bundleId,
        accessibility: read.accessibility,
        screenRecording: read.screenRecording,
      }),
    }),
  );
});

/** The grant target for the engine the driver would run now, and that target's grants. */
export function makeCuaGrantAccess<Engine extends GrantEngine>(input: {
  readonly environment: {
    readonly platform: NodeJS.Platform;
    readonly appUserModelId: string;
    readonly displayName: string;
  };
  readonly engine: Effect.Effect<Engine | string | undefined>;
  readonly readHelper: (engine: Engine) => Promise<CuaGrantRead>;
  readonly readApp: () => Promise<CuaGrantRead>;
  readonly note: CuaGrantReadLog;
}) {
  const { environment } = input;
  const grantTarget = Effect.gen(function* () {
    const chosen = environment.platform === "darwin" ? yield* input.engine : undefined;
    return cuaGrantTarget({
      platform: environment.platform,
      engine: chosen,
      appBundleId: environment.appUserModelId,
      readHelper: () =>
        chosen !== undefined && typeof chosen !== "string"
          ? input.readHelper(chosen)
          : Promise.reject(new Error("no helper")),
      readApp: input.readApp,
      note: input.note,
    });
  }).pipe(Effect.withSpan("desktop.cua.grantTarget"));
  return {
    grantTarget,
    grants: grantTarget.pipe(
      Effect.flatMap((target) => readCuaGrants(target, environment.displayName)),
    ),
  };
}

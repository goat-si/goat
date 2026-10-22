import type {
  DesktopDiscoveredSshHost,
  DesktopSshEnvironmentReadyOrPending,
  DesktopSshEnvironmentTarget,
  SshHostResult,
  SshRuntimeUpdateMode,
} from "@goat/contracts";
import * as NetService from "@goat/shared/Net";
import * as SshAuth from "@goat/ssh/auth";
import { resolveSshTarget, SshHostAnswered } from "@goat/ssh/command";
import { discoverSshHosts } from "@goat/ssh/config";
import {
  SshCommandError,
  SshEnsureSupersededError,
  SshHostDiscoveryError,
  SshInvalidTargetError,
  SshLaunchError,
  SshPairingError,
  SshPasswordPromptError,
  SshPreparationTimeoutError,
  SshReadinessError,
} from "@goat/ssh/errors";
import * as SshTunnel from "@goat/ssh/tunnel";
import * as Context from "effect/Context";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopSshPasswordPrompts from "./DesktopSshPasswordPrompts.ts";

export type DesktopSshEnvironmentRuntimeServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | NetService.NetService;

export type DesktopSshEnvironmentOperationError =
  | SshCommandError
  | SshInvalidTargetError
  | SshLaunchError
  | SshEnsureSupersededError
  | SshPreparationTimeoutError
  | SshPairingError
  | SshReadinessError
  | SshPasswordPromptError
  | NetService.NetError;

export type DesktopSshEnvironmentDiscoverError = SshHostDiscoveryError;

export type DesktopSshEnvironmentEnsureOptions = Pick<
  SshTunnel.SshEnvironmentEnsureOptions,
  | "issuePairingToken"
  | "keyOnly"
  | "preparedAttachmentId"
  | "onPreparationProgress"
  | "onPreparationAdmission"
>;

export class DesktopSshEnvironment extends Context.Service<
  DesktopSshEnvironment,
  {
    readonly discoverHosts: (input?: {
      readonly homeDir?: string;
    }) => Effect.Effect<readonly DesktopDiscoveredSshHost[], DesktopSshEnvironmentDiscoverError>;
    readonly resolveHost: (
      alias: string,
    ) => Effect.Effect<DesktopSshEnvironmentTarget, SshCommandError | SshInvalidTargetError>;
    readonly ensureEnvironment: (
      target: DesktopSshEnvironmentTarget,
      options?: DesktopSshEnvironmentEnsureOptions,
    ) => Effect.Effect<DesktopSshEnvironmentReadyOrPending, DesktopSshEnvironmentOperationError>;
    readonly status: (
      target: DesktopSshEnvironmentTarget,
    ) => Effect.Effect<SshHostResult, DesktopSshEnvironmentOperationError>;
    readonly update: (
      target: DesktopSshEnvironmentTarget,
      mode?: SshRuntimeUpdateMode,
    ) => Effect.Effect<SshHostResult, DesktopSshEnvironmentOperationError>;
    readonly disconnectEnvironment: (
      target: DesktopSshEnvironmentTarget,
    ) => Effect.Effect<void, DesktopSshEnvironmentOperationError>;
    /** Closes open SSH forwards that stopped answering, for example after sleep. */
    readonly revalidateTunnels: Effect.Effect<void>;
  }
>()("@goat/desktop/ssh/DesktopSshEnvironment") {}

export interface DesktopSshEnvironmentLayerOptions {
  readonly resolveCliRunner?: Effect.Effect<SshTunnel.RemoteGoatRunnerOptions>;
}

function discoverDesktopSshHostsEffect(input?: { readonly homeDir?: string }) {
  return discoverSshHosts(input ?? {});
}

export function isDesktopSshPasswordPromptCancellation(
  error: unknown,
): error is SshPasswordPromptError {
  return (
    error instanceof SshPasswordPromptError &&
    DesktopSshPasswordPrompts.isDesktopSshPasswordPromptCancellation(error.cause)
  );
}

function unexpectedPasswordPromptError(error: never): never {
  throw new Error(`Unhandled desktop SSH password prompt error: ${String(error)}`);
}

function toSshPasswordPromptError(
  cause: DesktopSshPasswordPrompts.DesktopSshPasswordPromptRequestError,
): SshPasswordPromptError {
  let message: string;
  switch (cause._tag) {
    case "DesktopSshPromptRequestIdGenerationError":
      message = "Secure randomness is unavailable.";
      break;
    case "DesktopSshPromptWindowUnavailableError":
    case "DesktopSshPromptPresentationError":
      message = "GOAT window is not available for SSH authentication.";
      break;
    case "DesktopSshPromptTimedOutError":
      message = `SSH authentication timed out for ${cause.destination}.`;
      break;
    case "DesktopSshPromptCancelledError":
      message = `SSH authentication cancelled for ${cause.destination}.`;
      break;
    case "DesktopSshPromptWindowClosedError":
      message = "SSH authentication was cancelled because the app window closed.";
      break;
    case "DesktopSshPromptServiceStoppedError":
      message = "SSH password prompt service stopped.";
      break;
    default:
      return unexpectedPasswordPromptError(cause);
  }
  return new SshPasswordPromptError({ message, cause });
}

const makePasswordPrompt = (
  prompts: DesktopSshPasswordPrompts.DesktopSshPasswordPrompts["Service"],
): SshAuth.SshPasswordPrompt["Service"] => ({
  isAvailable: true,
  request: (request: SshAuth.SshPasswordRequest) =>
    prompts.request(request).pipe(Effect.mapError(toSshPasswordPromptError)),
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const manager = yield* SshTunnel.SshEnvironmentManager;
  const prompts = yield* DesktopSshPasswordPrompts.DesktopSshPasswordPrompts;
  const runtimeContext = yield* Effect.context<DesktopSshEnvironmentRuntimeServices>();
  const passwordPrompt = SshAuth.SshPasswordPrompt.of(makePasswordPrompt(prompts));
  const keyOnlyPasswordPrompt = SshAuth.SshPasswordPrompt.of({
    isAvailable: false,
    request: () =>
      Effect.fail(new SshPasswordPromptError({ message: "SSH key authentication is required." })),
  });
  const generations = new Map<string, number>();
  const preparations = new Map<string, { answered: boolean; listeners: Set<() => void> }>();
  const targetKey = (target: DesktopSshEnvironmentTarget) =>
    JSON.stringify([target.alias, target.hostname, target.username, target.port]);
  const cancelledResult = (target: DesktopSshEnvironmentTarget): SshHostResult => ({
    kind: "error",
    code: "cancelled",
    message: `SSH runtime request cancelled for ${target.alias || target.hostname}.`,
  });
  const withCurrentRequest = (
    target: DesktopSshEnvironmentTarget,
    operation: (
      isCurrent: () => boolean,
    ) => Effect.Effect<SshHostResult, DesktopSshEnvironmentOperationError>,
  ) =>
    Effect.gen(function* () {
      const key = targetKey(target);
      const generation = generations.get(key) ?? 0;
      const isCurrent = () => (generations.get(key) ?? 0) === generation;
      const result = yield* operation(isCurrent).pipe(
        Effect.catch((error) =>
          isCurrent() ? Effect.fail(error) : Effect.succeed(cancelledResult(target)),
        ),
      );
      return isCurrent() ? result : cancelledResult(target);
    });
  const readStatus = (target: DesktopSshEnvironmentTarget) =>
    manager
      .status(target)
      .pipe(
        Effect.provideService(SshAuth.SshPasswordPrompt, keyOnlyPasswordPrompt),
        Effect.provide(runtimeContext),
      );

  return DesktopSshEnvironment.of({
    discoverHosts: (input) =>
      discoverDesktopSshHostsEffect(input).pipe(
        Effect.provide(runtimeContext),
        Effect.withSpan("desktop.ssh.discoverHosts"),
      ),
    resolveHost: (alias) =>
      resolveSshTarget(alias.trim()).pipe(
        Effect.provide(runtimeContext),
        Effect.withSpan("desktop.ssh.resolveHost"),
      ),
    ensureEnvironment: (target, ensureOptions) =>
      Effect.gen(function* () {
        const onAnswered = yield* SshHostAnswered;
        const listener = () => {
          try {
            onAnswered?.();
          } catch {
            // A destroyed renderer must not prevent other requests from observing authentication.
          }
        };
        const key = targetKey(target);
        const safelyNotify =
          <A>(notify: ((value: A) => void) | undefined) =>
          (value: A) => {
            try {
              notify?.(value);
            } catch {
              // Observers can outlive their renderer; they do not own native preparation.
            }
          };
        const managerOptions =
          ensureOptions === undefined
            ? undefined
            : {
                ...ensureOptions,
                ...(ensureOptions.onPreparationProgress === undefined
                  ? {}
                  : {
                      onPreparationProgress: safelyNotify(ensureOptions.onPreparationProgress),
                    }),
                ...(ensureOptions.onPreparationAdmission === undefined
                  ? {}
                  : {
                      onPreparationAdmission: safelyNotify(ensureOptions.onPreparationAdmission),
                    }),
              };
        return yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            const preparation = preparations.get(key) ?? { answered: false, listeners: new Set() };
            preparations.set(key, preparation);
            preparation.listeners.add(listener);
            return preparation;
          }),
          (preparation) =>
            Effect.gen(function* () {
              // Replay only after acquisition so notification failures cannot bypass cleanup.
              if (preparation.answered) listener();
              return yield* manager.ensureEnvironment(target, managerOptions).pipe(
                Effect.provideService(SshHostAnswered, () => {
                  if (preparations.get(key) !== preparation || preparation.answered) return;
                  preparation.answered = true;
                  for (const notify of preparation.listeners) notify();
                }),
              );
            }),
          (preparation) =>
            Effect.sync(() => {
              preparation.listeners.delete(listener);
              if (preparation.listeners.size === 0 && preparations.get(key) === preparation)
                preparations.delete(key);
            }),
        );
      }).pipe(
        Effect.provideService(SshAuth.SshPasswordPrompt, passwordPrompt),
        Effect.provide(runtimeContext),
        Effect.withSpan("desktop.ssh.ensureEnvironment"),
      ),
    status: (target) =>
      withCurrentRequest(target, () => readStatus(target)).pipe(
        Effect.withSpan("desktop.ssh.status"),
      ),
    update: (target, mode = "when_idle") =>
      withCurrentRequest(target, (isCurrent) =>
        manager
          .ensureEnvironment(target, {
            refreshRuntime: true,
            confirmReplacement: mode === "now",
            keyOnly: true,
            issuePairingToken: false,
          })
          .pipe(
            Effect.provideService(SshAuth.SshPasswordPrompt, keyOnlyPasswordPrompt),
            Effect.provide(runtimeContext),
            // The manager publishes structured failures as well as successful updates.
            Effect.matchEffect({
              onFailure: () =>
                isCurrent() ? readStatus(target) : Effect.succeed(cancelledResult(target)),
              onSuccess: () =>
                isCurrent() ? readStatus(target) : Effect.succeed(cancelledResult(target)),
            }),
          ),
      ).pipe(Effect.withSpan("desktop.ssh.update")),
    disconnectEnvironment: (target) =>
      Effect.suspend(() => {
        const key = targetKey(target);
        // Do not start a status probe when an update completes after disconnect.
        generations.set(key, (generations.get(key) ?? 0) + 1);
        preparations.delete(key);
        return manager.disconnectEnvironment(target);
      }).pipe(
        Effect.provideService(SshAuth.SshPasswordPrompt, passwordPrompt),
        Effect.provide(runtimeContext),
        Effect.withSpan("desktop.ssh.disconnectEnvironment"),
      ),
    revalidateTunnels: manager
      .revalidateTunnels()
      .pipe(
        Effect.provideService(SshAuth.SshPasswordPrompt, passwordPrompt),
        Effect.provide(runtimeContext),
        Effect.withSpan("desktop.ssh.revalidateTunnels"),
      ),
  });
});

export const layer = (options: DesktopSshEnvironmentLayerOptions = {}) =>
  Layer.effect(DesktopSshEnvironment, make).pipe(
    Layer.provide(
      // The remote server is shared with other clients (agent dispatch, other
      // desktops) and owns their running threads, so closing this app's tunnel
      // never stops it.
      SshTunnel.SshEnvironmentManager.layer({
        leaveRemoteServerRunning: true,
        ...(options.resolveCliRunner === undefined
          ? {}
          : { resolveCliRunner: options.resolveCliRunner }),
      }),
    ),
  );

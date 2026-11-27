import {
  AcpRegistryListProvidersResult,
  AcpRegistryOperationError,
  type AcpRegistryUrlAuthAction,
  type ProviderInstanceId,
} from "@goat/contracts";
import type { AcpRegistrySessionPage } from "@goat/provider-core/server/driver";
import * as AcpSessionRuntime from "@goat/provider-acp/server/AcpSessionRuntime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

import type { AcpRegistrySettings } from "../settings.ts";
import * as AcpRegistryRuntimeCoordinator from "./AcpRegistryRuntimeCoordinator.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import {
  acpRegistryProbeFailure,
  boundedOpaqueValue,
  boundedText,
  MAX_DESCRIPTION_LENGTH,
  MAX_ID_LENGTH,
  normalizeAcpRegistryWebUrl,
} from "./probeHelpers.ts";

const MAX_LISTED_SESSIONS = 1_280;
const MAX_LISTED_SESSION_BYTES = 1_048_576;
const MAX_RAW_CURSOR_CHARS = 16_384;
const MANAGEMENT_TIMEOUT = Duration.seconds(60);

export interface AcpRegistryManagementInput {
  readonly instanceId: ProviderInstanceId;
  readonly settings: AcpRegistrySettings;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}

const makeAcpRegistryManagementRuntime = Effect.fn("AcpRegistryProbe.makeManagementRuntime")(
  function* (input: AcpRegistryManagementInput) {
    const catalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const random = yield* SecureRandom.SecureRandom;
    const runtimeCoordinator = yield* Effect.serviceOption(
      AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
    );
    const resolved = yield* catalog
      .resolve(input.settings, input.cwd, input.environment)
      .pipe(Effect.mapError(AcpRegistrySupport.toAcpRegistryOperationError));
    const spawn = yield* catalog
      .prepareRuntimeSpawn(resolved)
      .pipe(Effect.mapError(AcpRegistrySupport.toAcpRegistryOperationError));
    const runtimeContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        spawn,
        cwd: input.cwd,
        clientCapabilities: {
          auth: { terminal: false },
          elicitation: { url: {} },
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "goat-session-manager", version: "0.0.0" },
        authenticateOnAuthRequired: false,
        ...(input.settings.authMethodId ? { authMethodId: input.settings.authMethodId } : {}),
      }).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
            Layer.succeed(SecureRandom.SecureRandom, random),
          ),
        ),
      ),
    );
    const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(runtimeContext),
    );
    yield* runtime.handleElicitation((request) =>
      Effect.gen(function* () {
        if (
          request.mode !== "url" ||
          !("url" in request) ||
          !("elicitationId" in request) ||
          typeof request.url !== "string" ||
          typeof request.elicitationId !== "string"
        ) {
          return { action: "decline" } as const;
        }
        const url = normalizeAcpRegistryWebUrl(request.url);
        const elicitationId = boundedOpaqueValue(request.elicitationId, MAX_ID_LENGTH);
        if (url === undefined || elicitationId === undefined) {
          return { action: "decline" } as const;
        }
        const action: AcpRegistryUrlAuthAction = {
          elicitationId,
          url,
          message: boundedText(request.message, MAX_DESCRIPTION_LENGTH),
        };
        const accepted = yield* Option.match(runtimeCoordinator, {
          onNone: () => Effect.succeed(false),
          onSome: (coordinator) => coordinator.requestUrlAuthentication(input.instanceId, action),
        });
        return accepted ? ({ action: "accept" } as const) : ({ action: "decline" } as const);
      }),
    );
    return runtime;
  },
);

function managementFailure(
  operation:
    | "list"
    | "delete"
    | "providers_list"
    | "providers_set"
    | "providers_disable"
    | "logout",
  error: EffectAcpErrors.AcpError | AcpRegistryOperationError,
): AcpRegistryOperationError {
  if (error._tag === "AcpRegistryOperationError") return error;
  if (error._tag === "AcpRequestError" && error.code === -32601) {
    if (operation === "list") {
      return new AcpRegistryOperationError({
        reason: "session_list_unsupported",
        message: "The ACP agent does not advertise session listing.",
        cause: error,
      });
    }
    if (operation === "delete") {
      return new AcpRegistryOperationError({
        reason: "session_delete_unsupported",
        message: "The ACP agent does not advertise session deletion.",
        cause: error,
      });
    }
    if (operation.startsWith("providers_")) {
      return new AcpRegistryOperationError({
        reason: "providers_unsupported",
        message: "The ACP agent does not advertise provider configuration.",
        cause: error,
      });
    }
    return new AcpRegistryOperationError({
      reason: "logout_unsupported",
      message: "The ACP agent does not advertise logout.",
      cause: error,
    });
  }
  const classified = acpRegistryProbeFailure(error);
  if (classified.reason === "authentication_failed") return classified;
  const failure =
    operation === "delete"
      ? { reason: "session_delete_failed" as const, message: "Could not delete the ACP session." }
      : operation === "providers_list"
        ? { reason: "providers_list_failed" as const, message: "Could not list ACP providers." }
        : operation === "providers_set" || operation === "providers_disable"
          ? {
              reason: "provider_configuration_failed" as const,
              message: "Could not update the ACP provider configuration.",
            }
          : undefined;
  return failure === undefined
    ? classified
    : new AcpRegistryOperationError({ ...failure, cause: error });
}

const listedSessionBytes = (session: {
  readonly sessionId: string;
  readonly cwd: string;
  readonly additionalDirectories: ReadonlyArray<string>;
  readonly title: string | null;
  readonly updatedAt: string | null;
}) =>
  session.sessionId.length +
  session.cwd.length +
  (session.title?.length ?? 0) +
  (session.updatedAt?.length ?? 0) +
  session.additionalDirectories.reduce((sum, directory) => sum + directory.length, 0);

export const listAcpRegistrySessions = Effect.fn("AcpRegistryProbe.listSessions")(
  function* (input: AcpRegistryManagementInput & { readonly cursor?: string }) {
    const runtime = yield* makeAcpRegistryManagementRuntime(input);
    const initialized = yield* runtime.initialize();
    const listed = yield* runtime.listSessions(input.cursor);
    const sessions: AcpRegistrySessionPage["sessions"][number][] = [];
    let bytes = 0;
    let droppedSessions = false;
    let directoriesCut = false;
    let overflow = false;
    for (const session of listed.sessions) {
      const sessionId = boundedOpaqueValue(session.sessionId, 1_024);
      const cwd = boundedOpaqueValue(session.cwd, 4_096);
      if (sessionId === undefined || cwd === undefined) {
        droppedSessions = true;
        continue;
      }
      const directories = session.additionalDirectories ?? [];
      const additionalDirectories: string[] = [];
      let cut = false;
      for (const directory of directories) {
        if (additionalDirectories.length === 32) {
          cut = true;
          break;
        }
        const normalized = boundedOpaqueValue(directory, 4_096);
        if (normalized === undefined) {
          cut = true;
          continue;
        }
        additionalDirectories.push(normalized);
      }
      if (cut) directoriesCut = true;
      const row = {
        sessionId,
        cwd,
        additionalDirectories,
        title:
          session.title === undefined || session.title === null
            ? null
            : boundedText(session.title, 1_024) || null,
        updatedAt:
          session.updatedAt === undefined || session.updatedAt === null
            ? null
            : boundedText(session.updatedAt, 128) || null,
        importedThreadId: null,
      };
      const size = listedSessionBytes(row);
      if (sessions.length === MAX_LISTED_SESSIONS || bytes + size > MAX_LISTED_SESSION_BYTES) {
        overflow = true;
        break;
      }
      sessions.push(row);
      bytes += size;
    }
    const provided = listed.nextCursor;
    const cursorText = typeof provided === "string" ? provided : undefined;
    const cursorDropped =
      cursorText !== undefined &&
      cursorText.trim().length > 0 &&
      cursorText.length > MAX_RAW_CURSOR_CHARS;
    const rawCursor =
      cursorText !== undefined && cursorText.trim().length > 0 && !cursorDropped
        ? cursorText
        : null;
    return {
      sessions,
      rawCursor,
      droppedSessions,
      directoriesCut,
      overflow,
      cursorDropped,
      canLoad: initialized.agentCapabilities?.loadSession === true,
      canResume: initialized.agentCapabilities?.sessionCapabilities?.resume != null,
      canDelete: initialized.agentCapabilities?.sessionCapabilities?.delete != null,
    } satisfies AcpRegistrySessionPage;
  },
  (effect) =>
    effect.pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: MANAGEMENT_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new AcpRegistryOperationError({
              reason: "probe_failed",
              message: "The ACP session list request timed out.",
            }),
          ),
      }),
      Effect.mapError((error) => managementFailure("list", error)),
    ),
);

export const deleteAcpRegistrySession = Effect.fn("AcpRegistryProbe.deleteSession")(
  function* (input: AcpRegistryManagementInput & { readonly sessionId: string }) {
    const runtime = yield* makeAcpRegistryManagementRuntime(input);
    yield* runtime.deleteSession(input.sessionId);
  },
  (effect) =>
    effect.pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: MANAGEMENT_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new AcpRegistryOperationError({
              reason: "session_delete_failed",
              message: "The ACP session delete request timed out.",
            }),
          ),
      }),
      Effect.mapError((error) => managementFailure("delete", error)),
    ),
);

export const listAcpRegistryProviders = Effect.fn("AcpRegistryProbe.listProviders")(
  function* (input: AcpRegistryManagementInput) {
    const runtime = yield* makeAcpRegistryManagementRuntime(input);
    const listed = yield* runtime.listProviders;
    return AcpRegistryListProvidersResult.make({
      providers: listed.providers.slice(0, 64).flatMap((provider) => {
        const providerId = boundedOpaqueValue(provider.providerId, 256);
        if (providerId === undefined) return [];
        const supported = provider.supported
          .flatMap((protocol) => {
            const value = boundedOpaqueValue(protocol, 64);
            return value === undefined ? [] : [value];
          })
          .slice(0, 16);
        const current = provider.current;
        const currentApiType =
          current == null ? undefined : boundedOpaqueValue(current.apiType, 64);
        const currentBaseUrl =
          current == null ? undefined : normalizeAcpRegistryWebUrl(current.baseUrl);
        return [
          {
            providerId,
            supported,
            required: provider.required,
            current:
              currentApiType === undefined || currentBaseUrl === undefined
                ? null
                : { apiType: currentApiType, baseUrl: currentBaseUrl },
          },
        ];
      }),
    });
  },
  (effect) =>
    effect.pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: MANAGEMENT_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new AcpRegistryOperationError({
              reason: "providers_list_failed",
              message: "The ACP provider list request timed out.",
            }),
          ),
      }),
      Effect.mapError((error) => managementFailure("providers_list", error)),
    ),
);

export const setAcpRegistryProvider = Effect.fn("AcpRegistryProbe.setProvider")(
  function* (input: AcpRegistryManagementInput & EffectAcpSchema.SetProviderRequest) {
    const runtime = yield* makeAcpRegistryManagementRuntime(input);
    yield* runtime.setProvider({
      providerId: input.providerId,
      apiType: input.apiType,
      baseUrl: input.baseUrl,
      ...(input.headers === undefined ? {} : { headers: input.headers }),
    });
  },
  (effect) =>
    effect.pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: MANAGEMENT_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new AcpRegistryOperationError({
              reason: "provider_configuration_failed",
              message: "The ACP provider configuration request timed out.",
            }),
          ),
      }),
      Effect.mapError((error) => managementFailure("providers_set", error)),
    ),
);

export const disableAcpRegistryProvider = Effect.fn("AcpRegistryProbe.disableProvider")(
  function* (input: AcpRegistryManagementInput & { readonly providerId: string }) {
    const runtime = yield* makeAcpRegistryManagementRuntime(input);
    yield* runtime.disableProvider(input.providerId);
  },
  (effect) =>
    effect.pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: MANAGEMENT_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new AcpRegistryOperationError({
              reason: "provider_configuration_failed",
              message: "The ACP provider disable request timed out.",
            }),
          ),
      }),
      Effect.mapError((error) => managementFailure("providers_disable", error)),
    ),
);

export const logoutAcpRegistry = Effect.fn("AcpRegistryProbe.logout")(
  function* (input: AcpRegistryManagementInput) {
    const runtime = yield* makeAcpRegistryManagementRuntime(input);
    yield* runtime.logout;
  },
  (effect) =>
    effect.pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: MANAGEMENT_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new AcpRegistryOperationError({
              reason: "probe_failed",
              message: "The ACP logout request timed out.",
            }),
          ),
      }),
      Effect.mapError((error) => managementFailure("logout", error)),
    ),
);

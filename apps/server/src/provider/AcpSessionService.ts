import {
  AcpRegistryOperationError,
  CommandId,
  type AcpRegistryListSessionsInput,
  type AcpRegistryListSessionsResult,
  type AcpRegistryImportSessionInput,
  type AcpRegistryImportSessionResult,
  type AcpRegistryDeleteSessionInput,
  type AcpRegistryDeleteSessionResult,
  type ProjectId,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as AcpRegistryRuntimeCoordinator from "@goat/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

export class AcpSessionService extends Context.Service<
  AcpSessionService,
  {
    readonly list: (
      input: AcpRegistryListSessionsInput,
    ) => Effect.Effect<AcpRegistryListSessionsResult, AcpRegistryOperationError>;
    readonly import: (
      input: AcpRegistryImportSessionInput,
    ) => Effect.Effect<AcpRegistryImportSessionResult, AcpRegistryOperationError>;
    readonly delete: (
      input: AcpRegistryDeleteSessionInput,
    ) => Effect.Effect<AcpRegistryDeleteSessionResult, AcpRegistryOperationError>;
  }
>()("goat/provider/AcpSessionService") {}

const make = Effect.gen(function* () {
  const projectService = yield* ProjectService.ProjectService;
  const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const acpRegistryRuntimeCoordinator =
    yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
  const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
  const crypto = yield* Crypto.Crypto;
  const acpRegistryProject = Effect.fn("AcpSessionService.project")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projectService.getById(projectId).pipe(
      Effect.mapError(
        (cause) =>
          new AcpRegistryOperationError({
            reason: "project_not_found",
            message: `Project ${projectId} is unavailable.`,
            cause,
          }),
      ),
    );
    return yield* Effect.fromOption(
      project,
      () =>
        new AcpRegistryOperationError({
          reason: "project_not_found",
          message: `Project ${projectId} was not found.`,
        }),
    );
  });

  const acpSessionManager = Effect.fn("AcpSessionService.sessionManager")(function* (
    instanceId: ProviderInstanceId,
  ) {
    const instance = yield* providerInstances.getInstance(instanceId);
    if (instance === undefined) {
      return yield* new AcpRegistryOperationError({
        reason: "instance_not_found",
        message: `Provider instance ${instanceId} was not found.`,
      });
    }
    if (instance.acpSessionManagement === undefined) {
      return yield* new AcpRegistryOperationError({
        reason: "session_list_unsupported",
        message: `Provider instance ${instanceId} does not expose ACP session management.`,
      });
    }
    return { instance, manager: instance.acpSessionManagement };
  });

  const importedAcpThreadId = (input: {
    readonly driver: ProviderDriverKind;
    readonly instanceId: ProviderInstanceId;
    readonly sessionId: string;
  }) =>
    IdAllocator.deriveThreadFromProviderThread({
      driver: input.driver,
      providerInstanceId: input.instanceId,
      nativeThreadId: input.sessionId,
    });

  const listAcpRegistrySessions = Effect.fn("ws.acpRegistry.listSessions")(function* (
    input: AcpRegistryListSessionsInput,
  ) {
    const project = yield* acpRegistryProject(input.projectId);
    const { instance, manager } = yield* acpSessionManager(input.instanceId);
    const listed = yield* manager.listSessions({
      cwd: project.workspaceRoot,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    });
    const sessions = yield* Effect.forEach(
      listed.sessions,
      (session) => {
        const threadId = importedAcpThreadId({
          driver: instance.driverKind,
          instanceId: input.instanceId,
          sessionId: session.sessionId,
        });
        return threadManagement.getThreadShell(threadId).pipe(
          Effect.map((thread) => ({
            ...session,
            importedThreadId: thread === null ? null : threadId,
          })),
          Effect.mapError(
            (cause) =>
              new AcpRegistryOperationError({
                reason: "session_import_failed",
                message: "Could not inspect existing imported ACP sessions.",
                cause,
              }),
          ),
        );
      },
      { concurrency: 16 },
    );
    return { ...listed, sessions };
  });

  const importAcpRegistrySession = Effect.fn("ws.acpRegistry.importSession")(function* (
    input: AcpRegistryImportSessionInput,
  ) {
    return yield* acpRegistryRuntimeCoordinator.withSessionMutation(
      Effect.gen(function* () {
        yield* acpRegistryProject(input.projectId);
        const { instance } = yield* acpSessionManager(input.instanceId);
        const providerSnapshot = yield* instance.snapshot.getSnapshot;
        if (
          providerSnapshot.nativeSessions?.canLoad !== true &&
          providerSnapshot.nativeSessions?.canResume !== true
        ) {
          return yield* new AcpRegistryOperationError({
            reason: "session_resume_unsupported",
            message: "The ACP agent cannot load or resume native sessions.",
          });
        }
        const threadId = importedAcpThreadId({
          driver: instance.driverKind,
          instanceId: input.instanceId,
          sessionId: input.sessionId,
        });
        const existing = yield* threadManagement.getThreadShell(threadId).pipe(
          Effect.mapError(
            (cause) =>
              new AcpRegistryOperationError({
                reason: "session_import_failed",
                message: "Could not inspect the imported ACP session mapping.",
                cause,
              }),
          ),
        );
        if (existing !== null) return { threadId, imported: false } as const;

        const provider = (yield* providerRegistry.getProviders).find(
          (candidate) => candidate.instanceId === input.instanceId,
        );
        const model =
          provider?.models.find((candidate) => candidate.isDefault)?.slug ??
          provider?.models[0]?.slug ??
          "default";
        const commandId = CommandId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie));
        const launched = yield* Effect.result(
          startup.enqueueCommand(
            threadLaunch.launch({
              commandId,
              threadId,
              projectId: input.projectId,
              title: input.title ?? "Imported ACP session",
              modelSelection: { instanceId: input.instanceId, model },
              runtimeMode: "approval-required",
              interactionMode: "default",
              workspaceStrategy: { type: "root" },
              importedNativeThread: {
                ref: {
                  driver: instance.driverKind,
                  nativeId: input.sessionId,
                  strength: "strong",
                },
                metadata: {
                  itemIdentityVersion: 2,
                  ...(input.title === undefined ? {} : { title: input.title }),
                  ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }),
                },
              },
              createdBy: "user",
              creationSource: "web",
            }),
          ),
        );
        if (Result.isFailure(launched)) {
          const racedImport = yield* threadManagement.getThreadShell(threadId).pipe(
            Effect.mapError(
              (cause) =>
                new AcpRegistryOperationError({
                  reason: "session_import_failed",
                  message: "Could not inspect the imported ACP session after launch failed.",
                  cause,
                }),
            ),
          );
          if (racedImport !== null) return { threadId, imported: false } as const;
          return yield* new AcpRegistryOperationError({
            reason: "session_import_failed",
            message: "Could not create a GOAT thread for the ACP session.",
            cause: launched.failure,
          });
        }
        return { threadId, imported: true } as const;
      }),
    );
  });

  const deleteAcpRegistrySession = Effect.fn("ws.acpRegistry.deleteSession")(function* (
    input: AcpRegistryDeleteSessionInput,
  ) {
    return yield* acpRegistryRuntimeCoordinator.withSessionMutation(
      Effect.gen(function* () {
        const project = yield* acpRegistryProject(input.projectId);
        const { instance, manager } = yield* acpSessionManager(input.instanceId);
        const snapshot = yield* instance.snapshot.getSnapshot;
        if (snapshot.nativeSessions?.canDelete !== true) {
          return yield* new AcpRegistryOperationError({
            reason: "session_delete_unsupported",
            message: "The ACP agent does not advertise session deletion.",
          });
        }
        const threadId = importedAcpThreadId({
          driver: instance.driverKind,
          instanceId: input.instanceId,
          sessionId: input.sessionId,
        });
        const importedThread = yield* threadManagement.getThreadShell(threadId).pipe(
          Effect.mapError(
            (cause) =>
              new AcpRegistryOperationError({
                reason: "session_delete_failed",
                message: "Could not inspect the imported ACP session mapping.",
                cause,
              }),
          ),
        );
        if (importedThread !== null) {
          return yield* new AcpRegistryOperationError({
            reason: "session_delete_failed",
            message: "Delete the imported GOAT thread before deleting its native ACP session.",
          });
        }
        yield* manager.deleteSession({
          cwd: project.workspaceRoot,
          sessionId: input.sessionId,
        });
        return { deleted: true } as const;
      }),
    );
  });

  return AcpSessionService.of({
    list: listAcpRegistrySessions,
    import: importAcpRegistrySession,
    delete: deleteAcpRegistrySession,
  });
});

export const layer = Layer.effect(AcpSessionService, make);

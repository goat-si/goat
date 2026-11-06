import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ServerCommand,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "./SecretRequests.ts";

export const threadId = ThreadId.make("thread-orchestrator");
export const turnItemId = TurnItemId.make("turn-item:secret-request:1");
export const projectId = ProjectId.make("project-1");
export const withService = <A, E>(
  body: (input: {
    readonly service: SecretRequests.SecretRequests["Service"];
    readonly stored: Map<string, Uint8Array>;
    readonly dispatched: Array<OrchestrationV2ServerCommand>;
  }) => Effect.Effect<A, E>,
  options: {
    readonly threadId?: ThreadId;
    readonly delivery?: "file";
    readonly siteOrigin?: string;
    readonly requestKind?: "login" | "card";
    readonly directory?: string;
    readonly runStatus?: string;
    readonly removeFails?: boolean;
    readonly closedFirst?: boolean;
    readonly failedRecords?: number;
    readonly readReference?: typeof import("./secretResolver.ts").resolveSecret;
  } = {},
) =>
  Effect.gen(function* () {
    const stored = new Map<string, Uint8Array>();
    const dispatched: Array<OrchestrationV2ServerCommand> = [];
    let secretStatus = "pending";
    let failedRecords = options.failedRecords ?? 0;
    const requestThreadId = options.threadId ?? threadId;
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      ServerSettings.layerTest(),
      NodeServices.layer,
      Layer.succeed(
        ServerSecretStore.ServerSecretStore,
        ServerSecretStore.ServerSecretStore.of({
          ...(options.directory === undefined ? {} : { directory: options.directory }),
          get: (name) => Effect.yieldNow.pipe(Effect.as(Option.fromNullishOr(stored.get(name)))),
          set: (name, value) => Effect.sync(() => void stored.set(name, value)),
          create: (name, value) =>
            stored.has(name)
              ? Effect.fail(
                  new ServerSecretStore.SecretStorePersistError({
                    resource: name,
                    cause: new PlatformError.PlatformError(
                      new PlatformError.SystemError({
                        _tag: "AlreadyExists",
                        module: "FileSystem",
                        method: "open",
                      }),
                    ),
                  } as never),
                )
              : Effect.sync(() => void stored.set(name, value)),
          getOrCreateRandom: (name, bytes) =>
            Effect.sync(() => {
              const existing = stored.get(name);
              if (existing) return existing;
              const value = new Uint8Array(bytes).fill(7);
              stored.set(name, value);
              return value;
            }),
          remove: (name) =>
            options.removeFails
              ? Effect.fail(
                  new ServerSecretStore.SecretStorePersistError({
                    resource: name,
                    cause: new Error("read-only"),
                  }),
                )
              : Effect.sync(() => void stored.delete(name)),
        }),
      ),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadRecords: () =>
          Effect.succeed({
            thread: { projectId },
            runs: [{ id: "run-1", status: options.runStatus ?? "running" }],
            turnItems: [
              {
                id: turnItemId,
                threadId: requestThreadId,
                runId: "run-1",
                nodeId: "node-root",
                type: "secret_request",
                label: "GitHub token",
                reason: "Used as GH_TOKEN.",
                ...(options.delivery === undefined ? {} : { delivery: options.delivery }),
                ...(options.siteOrigin === undefined ? {} : { siteOrigin: options.siteOrigin }),
                ...(options.requestKind === undefined ? {} : { requestKind: options.requestKind }),
                secretStatus,
              },
            ],
          } as never),
        dispatch: (command) => {
          if (command.type === "secret_request.record" && failedRecords > 0) {
            failedRecords -= 1;
            return Effect.fail(new Error("orchestrator unavailable") as never);
          }
          return Effect.sync(() => {
            dispatched.push(command);
            if (options.closedFirst && command.type === "secret_request.record") {
              secretStatus = "cancelled";
            } else if (command.type === "secret_request.record" && secretStatus === "pending") {
              secretStatus = command.secretStatus;
            }
            return {} as never;
          });
        },
      }),
    );
    return yield* Effect.gen(function* () {
      const service = yield* SecretRequests.SecretRequests;
      return yield* body({ service, stored, dispatched });
    }).pipe(
      Effect.provide(
        (options.readReference
          ? SecretRequests.layerWithReader(options.readReference)
          : SecretRequests.layer
        ).pipe(Layer.provide(layerDependencies)),
      ),
    );
  });

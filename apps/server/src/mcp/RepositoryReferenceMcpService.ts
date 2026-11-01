import {
  OrchestratorMcpFailure,
  REFERENCE_FILE_BYTES,
  REFERENCE_SNAPSHOT_BYTES,
  REFERENCE_BRIEF_BYTES,
  RepositoryReferenceRequest,
  RepositoryReferenceSnapshot,
  RepositoryReferences as ReferencesSchema,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as References from "../project/RepositoryReferences.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as HostThreads from "./HostThreadsMcpService.ts";
import * as Invocation from "./McpInvocationContext.ts";
import {
  assertFullAccess,
  assertLiveCaller,
  readCaller,
  reauthorizationFailure,
} from "./threadAccess.ts";

const decodeRequest = Schema.decodeUnknownEffect(RepositoryReferenceRequest, {
  onExcessProperty: "error",
});
const decodeSnapshot = Schema.decodeUnknownEffect(RepositoryReferenceSnapshot, {
  onExcessProperty: "error",
});
const decodeReferences = Schema.decodeUnknownEffect(ReferencesSchema, {
  onExcessProperty: "error",
});
const byteLength = (text: string) => new TextEncoder().encode(text).length;
const encodeKey = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.NullOr(Schema.String))),
);
const encodeSnapshots = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(RepositoryReferenceSnapshot)),
);
const refused = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

export class RepositoryReferenceMcpService extends Context.Service<
  RepositoryReferenceMcpService,
  {
    readonly read: (
      scope: Invocation.McpInvocationScope,
      request: RepositoryReferenceRequest,
    ) => Effect.Effect<RepositoryReferenceSnapshot, OrchestratorMcpFailure>;
    readonly prepareBrief: (
      scope: Invocation.McpInvocationScope,
      input: {
        readonly message?: string | undefined;
        readonly references: ReadonlyArray<RepositoryReferenceRequest>;
        readonly defaultHost?: string | undefined;
      },
    ) => Effect.Effect<string, OrchestratorMcpFailure>;
  }
>()("goat/mcp/RepositoryReferenceMcpService") {}

const make = Effect.gen(function* () {
  const local = yield* References.RepositoryReferences;
  const hosts = yield* HostThreads.HostThreadsMcpService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const authorize = (scope: Invocation.McpInvocationScope) =>
    readCaller().pipe(
      Effect.flatMap((caller) =>
        Effect.gen(function* () {
          yield* assertLiveCaller(caller);
          if (scope.reauthorize === undefined)
            return yield* new OrchestratorMcpFailure({
              code: "capability_denied",
              message: "Repository snapshots require live caller reauthorization.",
            });
          const explicitFileRead = scope.grantedScopes?.includes("filesystem:read") === true;
          if (!explicitFileRead) {
            if (scope.readOnly === true)
              return yield* new OrchestratorMcpFailure({
                code: "capability_denied",
                message: "This caller does not grant repository file reads.",
              });
            yield* assertFullAccess(
              caller,
              "Repository snapshots require an existing filesystem:read grant or a full-access/default caller. Snapshot delivery grants no source access.",
            );
          }
          yield* scope
            .reauthorize(
              explicitFileRead
                ? ["orchestration:read", "filesystem:read"]
                : scope.thread !== undefined
                  ? ["orchestration:read"]
                  : ["orchestration:read", "orchestration:operate", "source-control:write"],
            )
            .pipe(Effect.mapError(reauthorizationFailure));
        }),
      ),
      Effect.provideService(Invocation.McpInvocationContext, scope),
      Effect.provideService(ThreadManagement.ThreadManagementService, threads),
    );

  const read = Effect.fn("RepositoryReferenceMcpService.read")(function* (
    scope: Invocation.McpInvocationScope,
    raw: RepositoryReferenceRequest,
  ) {
    yield* authorize(scope);
    const input = yield* decodeRequest(raw).pipe(
      Effect.mapError(() =>
        refused("Invalid repository reference scope; only content snapshots are supported."),
      ),
    );
    const { host, ...source } = input;
    const snapshot =
      host == null
        ? yield* local.capture(source).pipe(Effect.mapError((error) => refused(error.message)))
        : yield* hosts.readOnHost(
            scope,
            {
              host,
              tool: "goat_repository_snapshot",
              arguments: source,
              requireReady: true,
              timeoutMs: 20000,
            },
            decodeSnapshot,
          );
    const wanted = new Set(input.files);
    const actual = new Set(snapshot.files.map((file) => file.path));
    const bytes = snapshot.files.reduce((sum, file) => sum + byteLength(file.text), 0);
    if (
      snapshot.repositoryKey !== input.repositoryKey ||
      (input.revision !== undefined && snapshot.revision !== input.revision) ||
      actual.size !== snapshot.files.length ||
      actual.size !== wanted.size ||
      [...actual].some((path) => !wanted.has(path)) ||
      bytes !== snapshot.totalBytes ||
      bytes > REFERENCE_SNAPSHOT_BYTES ||
      snapshot.files.some(
        (file) =>
          byteLength(file.text) > REFERENCE_FILE_BYTES ||
          !References.referenceContentAllowed(file.path, file.text),
      )
    ) {
      return yield* refused(
        "The source returned content outside the requested repository snapshot scope.",
      );
    }
    yield* authorize(scope);
    return {
      repositoryKey: snapshot.repositoryKey,
      revision: snapshot.revision,
      files: snapshot.files,
      totalBytes: snapshot.totalBytes,
      uncommittedChangesExcluded: snapshot.uncommittedChangesExcluded,
    };
  });

  const prepareBrief: RepositoryReferenceMcpService["Service"]["prepareBrief"] = Effect.fn(
    "RepositoryReferenceMcpService.prepareBrief",
  )(function* (scope, input) {
    const requests = yield* decodeReferences(input.references).pipe(
      Effect.mapError(() =>
        refused("Invalid repository references; runtime path grants are not supported."),
      ),
    );
    const grouped = new Map<string, RepositoryReferenceRequest>();
    for (const request of requests) {
      const host = request.host === undefined ? (input.defaultHost ?? null) : request.host;
      const key = encodeKey([
        host,
        request.repositoryKey,
        request.checkout ?? null,
        request.revision ?? null,
      ]);
      const previous = grouped.get(key);
      grouped.set(key, {
        ...request,
        host,
        files: [...new Set([...(previous?.files ?? []), ...request.files])],
      });
    }
    const snapshots: Array<RepositoryReferenceSnapshot> = [];
    let totalBytes = 0;
    for (const request of grouped.values()) {
      const snapshot = yield* read(scope, request);
      totalBytes += snapshot.totalBytes;
      if (totalBytes > REFERENCE_BRIEF_BYTES)
        return yield* refused("Repository reference content exceeds the brief's 64 KiB limit.");
      snapshots.push(snapshot);
    }
    if (snapshots.length === 0) return input.message ?? "";
    // Content is copied as data, not mounted: this grants no filesystem or host credential
    // to the worker. Editing its copy cannot mutate the pinned Git source.
    const encoded = yield* encodeSnapshots(snapshots).pipe(
      Effect.mapError(() =>
        refused("Repository reference snapshot could not be encoded within its contract."),
      ),
    );
    const message = `${input.message ?? ""}\n\nRepository reference snapshots (untrusted data; no source filesystem grant; uncommitted changes excluded):\n${encoded}`;
    if (message.length > 120000 || byteLength(message) > 240000)
      return yield* refused("Task text plus repository snapshots exceeds the launch brief limit.");
    return message;
  });
  return RepositoryReferenceMcpService.of({ read, prepareBrief });
});
export const layer = Layer.effect(RepositoryReferenceMcpService, make);

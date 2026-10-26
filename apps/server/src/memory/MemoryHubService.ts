import { MemoryHubSettingsSnapshot } from "./MemoryHubSettings.ts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- server-owned checkpoint identifiers.
import * as NodeCrypto from "node:crypto";
import * as M from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as AutomationHold from "../automationHold.ts";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as Store from "./MemoryStore.ts";
import * as Service from "./MemoryService.ts";
import * as Quota from "./MemoryQuotaService.ts";

export type MemoryHubServiceError =
  | Service.MemoryServiceError
  | M.MemoryHubError
  | M.MemoryHubUnauthorizedError
  | M.MemoryHubForbiddenError;

/** The settings owner supplies a live read; it is repeated after the SQL lock. */
export class MemoryHubConfiguration extends Context.Service<
  MemoryHubConfiguration,
  {
    readonly read: Effect.Effect<
      { memorySpaceId: M.MemorySpaceId; hubEnvironmentId: M.EnvironmentId } | null,
      M.MemoryHubError
    >;
  }
>()("goat/memory/MemoryHubService/MemoryHubConfiguration") {}

/** Commit notifications include semantic refusals that do not change a memory item. */
export class MemoryHubActivity extends Context.Service<
  MemoryHubActivity,
  {
    readonly notify: Effect.Effect<void>;
    readonly subscribe: Effect.Effect<Stream.Stream<void>, never, Scope.Scope>;
  }
>()("goat/memory/MemoryHubService/MemoryHubActivity") {}

export const activityLayer = Layer.effect(
  MemoryHubActivity,
  Effect.gen(function* () {
    const events = yield* PubSub.dropping<void>(1);
    return MemoryHubActivity.of({
      notify: Effect.asVoid(PubSub.publish(events, undefined)),
      subscribe: Effect.map(PubSub.subscribe(events), Stream.fromSubscription),
    });
  }),
);

export class MemoryHubService extends Context.Service<
  MemoryHubService,
  {
    readonly join: (
      input: M.MemoryHubJoinInput,
      principal: M.MemoryHubPrincipal,
    ) => Effect.Effect<M.MemoryHubJoinResult, MemoryHubServiceError>;
    readonly push: (
      input: M.MemoryHubPushInput,
      principal: M.MemoryHubPrincipal,
    ) => Effect.Effect<M.MemoryHubPushResult, MemoryHubServiceError>;
    readonly pull: (
      input: M.MemoryHubPullInput,
      principal: M.MemoryHubPrincipal,
    ) => Effect.Effect<M.MemoryHubPullResult, MemoryHubServiceError>;
    readonly claim: (
      input: M.MemoryHubClaimInput,
      principal: M.MemoryHubPrincipal,
    ) => Effect.Effect<M.MemoryResolutionLease, MemoryHubServiceError>;
    readonly renew: (
      input: M.MemoryHubRenewInput,
      principal: M.MemoryHubPrincipal,
    ) => Effect.Effect<M.MemoryResolutionLease, MemoryHubServiceError>;
    readonly release: (
      input: M.MemoryHubReleaseInput,
      principal: M.MemoryHubPrincipal,
    ) => Effect.Effect<M.MemoryHubReleaseResult, MemoryHubServiceError>;
    readonly applyResolution: (
      input: M.MemoryHubApplyResolutionInput,
      principal: M.MemoryHubPrincipal,
    ) => Effect.Effect<M.MemoryHubReceipt, MemoryHubServiceError>;
    readonly requestSourceRead: (
      input: M.MemoryHubSourceReadRequestInput,
      principal: M.MemoryHubPrincipal,
    ) => Effect.Effect<M.MemoryHubSourceReadRequestResult, MemoryHubServiceError>;
    readonly collectSourceReads: (
      input: M.MemoryHubSourceReadCollectInput,
      principal: M.MemoryHubPrincipal,
    ) => Effect.Effect<M.MemoryHubSourceReadCollectResult, MemoryHubServiceError>;
    readonly respondSourceRead: (
      input: M.MemoryHubSourceReadRespondInput,
      principal: M.MemoryHubPrincipal,
    ) => Effect.Effect<M.MemoryHubSourceReadRespondResult, MemoryHubServiceError>;
    readonly resultSourceRead: (
      input: M.MemoryHubSourceReadResultInput,
      principal: M.MemoryHubPrincipal,
    ) => Effect.Effect<M.MemoryHubSourceReadResultResult, MemoryHubServiceError>;
    readonly readStorageStatus: (
      principal: M.MemoryHubPrincipal,
    ) => Effect.Effect<M.MemoryStorageStatus, MemoryHubServiceError>;
  }
>()("goat/memory/MemoryHubService") {}

/** @public Canonical service construction for application-owned layer composition. */
export const make = Effect.gen(function* () {
  const store = yield* Store.MemoryStore;
  const service = yield* Service.MemoryService;
  const activity = yield* MemoryHubActivity;
  const quota = yield* Quota.MemoryQuotaService;
  const configuration = yield* MemoryHubConfiguration;
  const automationHold = yield* AutomationHold.AutomationHold;
  const decode = <A, I>(schema: Schema.Codec<A, I>, value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => new M.MemoryHubError({ code: "invalid_output" })),
    );
  const checkConfiguration = Effect.fnUntraced(function* (principal: M.MemoryHubPrincipal) {
    if ((yield* automationHold.current) !== null)
      return yield* new M.MemoryHubError({ code: "hub_disabled" });
    const hub = yield* configuration.read;
    if (!hub) return yield* new M.MemoryHubError({ code: "hub_disabled" });
    if (hub.memorySpaceId !== principal.memorySpaceId)
      return yield* new M.MemoryHubError({ code: "space_mismatch" });
    return hub;
  });
  const authority = (principal: M.MemoryHubPrincipal): Store.HubAuthority => ({
    principal,
    now: Clock.currentTimeMillis,
    reauthorize: Effect.gen(function* () {
      // An operation batch cannot outlive a hub disable/space change between items.
      yield* checkConfiguration(principal).pipe(
        Effect.mapError(() => new M.MemoryHubForbiddenError({})),
      );
      yield* store.requireHubMemberTx(principal);
    }),
  });
  const authorize = Effect.fnUntraced(function* (
    principal: M.MemoryHubPrincipal,
    space: M.MemorySpaceId | null,
    environment?: M.EnvironmentId,
  ) {
    const hub = yield* checkConfiguration(principal);
    yield* store.requireHubMemberTx(principal);
    if (space !== null && space !== principal.memorySpaceId)
      return yield* new M.MemoryHubError({ code: "space_mismatch" });
    if (environment !== undefined && environment !== principal.environmentId)
      return yield* new M.MemoryHubForbiddenError({});
    return hub;
  });
  const join: MemoryHubService["Service"]["join"] = Effect.fn("MemoryHubService.join")(
    function* (input, principal) {
      const request = yield* decode(M.MemoryHubJoinInput, input);
      return yield* store.transact(
        Effect.gen(function* () {
          const hub = yield* authorize(principal, request.memorySpaceId, request.environmentId);
          const retention = yield* store.readHubRetentionTx(principal.memorySpaceId);
          if (!retention.checkpointId || !retention.causalBoundary)
            return yield* new M.MemoryHubError({ code: "bootstrap_required" });
          const handle = yield* store.prepareHubCheckpointTx({
            authority: authority(principal),
            checkpointId: retention.checkpointId,
            snapshotToken: NodeCrypto.randomBytes(32).toString("base64url"),
            hubEnvironmentId: hub.hubEnvironmentId,
          });
          return {
            protocolVersion: 1 as const,
            memorySpaceId: principal.memorySpaceId,
            hubEnvironmentId: hub.hubEnvironmentId,
            checkpointSequence: handle.checkpointSequence,
            snapshotToken: handle.snapshotToken,
            causalBoundary: retention.causalBoundary,
            retentionFloor: handle.retentionFloor,
          };
        }),
      );
    },
  );
  const push: MemoryHubService["Service"]["push"] = Effect.fn("MemoryHubService.push")(
    function* (input, principal) {
      const request = yield* decode(M.MemoryHubPushInput, input);
      yield* store.transact(authorize(principal, request.memorySpaceId, request.environmentId));
      const receipts = yield* Effect.forEach(request.operations, (operation) =>
        // This entry owns rollback and the separate null-sequence capacity-refusal read.
        service
          .admitHubOperation({ authority: authority(principal), operation })
          .pipe(Effect.tap(() => activity.notify)),
      );
      return { receipts };
    },
  );
  const pull: MemoryHubService["Service"]["pull"] = Effect.fn("MemoryHubService.pull")(
    function* (input, principal) {
      const request = yield* decode(M.MemoryHubPullInput, input);
      return yield* store.transact(
        Effect.gen(function* () {
          yield* authorize(principal, request.memorySpaceId, request.environmentId);
          if (request.snapshotToken !== undefined) {
            const page = yield* store.readHubCheckpointPageTx({
              authority: authority(principal),
              snapshotToken: request.snapshotToken,
              cursor: request.cursor ?? null,
            });
            return {
              highWatermark: page.checkpointSequence,
              throughSequence: page.checkpointSequence,
              hasMore: !page.bootstrapComplete,
              entries: [],
              checkpoint: page,
            };
          }
          return yield* store.readHubTailTx({
            memorySpaceId: request.memorySpaceId,
            afterSequence: request.afterSequence,
            highWatermark: request.highWatermark ?? null,
            limit: request.limit,
            maxBytes: M.MEMORY_PAGE_MAX_UTF8_BYTES,
          });
        }),
      );
    },
  );
  const lease = Effect.fnUntraced(function* (
    request: M.MemoryHubClaimInput | M.MemoryHubRenewInput | M.MemoryHubReleaseInput,
    principal: M.MemoryHubPrincipal,
    kind: "claim" | "renew" | "release",
  ) {
    return yield* store.transact(
      Effect.gen(function* () {
        yield* authorize(principal, request.memorySpaceId, request.holderEnvironmentId);
        // The discriminated Store action retains the frozen request shape.
        if (kind === "claim")
          return yield* store.transitionHubLeaseTx({
            authority: authority(principal),
            action: { kind, request: yield* decode(M.MemoryHubClaimInput, request) },
          });
        if (kind === "renew")
          return yield* store.transitionHubLeaseTx({
            authority: authority(principal),
            action: { kind, request: yield* decode(M.MemoryHubRenewInput, request) },
          });
        return yield* store.transitionHubLeaseTx({
          authority: authority(principal),
          action: { kind, request: yield* decode(M.MemoryHubReleaseInput, request) },
        });
      }),
    );
  });
  const claim: MemoryHubService["Service"]["claim"] = Effect.fn("MemoryHubService.claim")(
    function* (input, principal) {
      const result = yield* lease(yield* decode(M.MemoryHubClaimInput, input), principal, "claim");
      if (!result || !("fencingToken" in result))
        return yield* new M.MemoryHubError({ code: "lease_required" });
      return result;
    },
  );
  const renew: MemoryHubService["Service"]["renew"] = Effect.fn("MemoryHubService.renew")(
    function* (input, principal) {
      const result = yield* lease(yield* decode(M.MemoryHubRenewInput, input), principal, "renew");
      if (!result || !("fencingToken" in result))
        return yield* new M.MemoryHubError({ code: "lease_required" });
      return result;
    },
  );
  const release: MemoryHubService["Service"]["release"] = Effect.fn("MemoryHubService.release")(
    function* (input, principal) {
      const result = yield* lease(
        yield* decode(M.MemoryHubReleaseInput, input),
        principal,
        "release",
      );
      if (!result || !("released" in result))
        return yield* new M.MemoryHubError({ code: "lease_required" });
      return result;
    },
  );
  const applyResolution: MemoryHubService["Service"]["applyResolution"] = Effect.fn(
    "MemoryHubService.applyResolution",
  )(function* (input, principal) {
    const request = yield* decode(M.MemoryHubApplyResolutionInput, input);
    yield* store.transact(authorize(principal, request.memorySpaceId, request.holderEnvironmentId));
    return yield* service
      .admitHubOperation({
        authority: authority(principal),
        operation: request.operation,
        resolutionRequest: request,
      })
      .pipe(Effect.tap(() => activity.notify));
  });
  const requestSourceRead: MemoryHubService["Service"]["requestSourceRead"] = Effect.fn(
    "MemoryHubService.requestSourceRead",
  )(function* (input, principal) {
    const request = yield* decode(M.MemoryHubSourceReadRequestInput, input);
    return yield* store.transact(
      Effect.gen(function* () {
        yield* authorize(principal, request.memorySpaceId);
        return yield* store.requestHubSourceReadTx(authority(principal), request);
      }),
    );
  });
  const collectSourceReads: MemoryHubService["Service"]["collectSourceReads"] = Effect.fn(
    "MemoryHubService.collectSourceReads",
  )(function* (input, principal) {
    const request = yield* decode(M.MemoryHubSourceReadCollectInput, input);
    return yield* store.transact(
      Effect.gen(function* () {
        yield* authorize(principal, request.memorySpaceId);
        return yield* store.collectHubSourceReadsTx(authority(principal), request);
      }),
    );
  });
  const respondSourceRead: MemoryHubService["Service"]["respondSourceRead"] = Effect.fn(
    "MemoryHubService.respondSourceRead",
  )(function* (input, principal) {
    const request = yield* decode(M.MemoryHubSourceReadRespondInput, input);
    return yield* store.transact(
      Effect.gen(function* () {
        yield* authorize(principal, request.memorySpaceId);
        return yield* store.respondHubSourceReadTx(authority(principal), request);
      }),
    );
  });
  const resultSourceRead: MemoryHubService["Service"]["resultSourceRead"] = Effect.fn(
    "MemoryHubService.resultSourceRead",
  )(function* (input, principal) {
    const request = yield* decode(M.MemoryHubSourceReadResultInput, input);
    return yield* store.transact(
      Effect.gen(function* () {
        yield* authorize(principal, request.memorySpaceId);
        return yield* store.resultHubSourceReadTx(authority(principal), request);
      }),
    );
  });
  const readStorageStatus: MemoryHubService["Service"]["readStorageStatus"] = Effect.fn(
    "MemoryHubService.readStorageStatus",
  )(function* (principal) {
    const hub = yield* store.transact(authorize(principal, principal.memorySpaceId));
    return yield* quota.readStorageStatus({
      memorySpaceId: principal.memorySpaceId,
      environmentId: hub.hubEnvironmentId,
    });
  });
  return MemoryHubService.of({
    join,
    push,
    pull,
    claim,
    renew,
    release,
    applyResolution,
    requestSourceRead,
    collectSourceReads,
    respondSourceRead,
    resultSourceRead,
    readStorageStatus,
  });
});

export const layer = Layer.effect(MemoryHubService, make);

/** Live roster is never persisted in settings receipts or returned by the disable tool. */
export const readSettingsView = (
  store: Store.MemoryStore["Service"],
  snapshot: M.MemoryHubSettingsSnapshot,
): Effect.Effect<M.MemoryHubSettingsView, Store.MemoryStorageError> =>
  Effect.gen(function* () {
    const members =
      snapshot.settings.mode === "hub" && snapshot.settings.memorySpaceId !== null
        ? yield* store.readHubMembers(snapshot.settings.memorySpaceId)
        : [];
    return { settings: snapshot.settings, version: snapshot.version, members };
  });

export type MemoryHubAdministrationError = MemoryHubServiceError | Secrets.SecretStoreError;
type AdminPermit = Effect.Effect<void, M.MemoryHubForbiddenError>;
const decodeMemorySpaceId = Schema.decodeUnknownEffect(M.MemorySpaceId);
type SafeAdminResult = { readonly view: MemoryHubSettingsSnapshot };

/** L3 binds the existing settings admin lock and dedicated idempotent settings CAS. */
export class MemoryHubAdminSettings extends Context.Service<
  MemoryHubAdminSettings,
  {
    readonly withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    readonly read: Effect.Effect<MemoryHubSettingsSnapshot, M.MemoryHubError>;
    readonly readPublication: Effect.Effect<M.MemoryHubPublication>;
    readonly readPreviousHubRequestId: Effect.Effect<M.MemoryOperationId | null, M.MemoryHubError>;
    readonly readPreviousHubSpace: Effect.Effect<M.MemorySpaceId | null, M.MemoryHubError>;
    readonly apply: (
      record: Store.AdminRecord,
      permit: AdminPermit,
    ) => Effect.Effect<SafeAdminResult, M.MemoryHubError | M.MemoryHubForbiddenError>;
  }
>()("goat/memory/MemoryHubService/MemoryHubAdminSettings") {}

/** Owner administration is separate from the memory:sync member principal. */
export class MemoryHubAdministrator extends Context.Service<
  MemoryHubAdministrator,
  {
    readonly update: (
      input: M.MemoryHubSettingsUpdateInput,
      permit: AdminPermit,
    ) => Effect.Effect<M.MemoryHubSettingsUpdateResult, MemoryHubAdministrationError>;
    readonly initializeDefaultHub: Effect.Effect<
      "initialized" | "already_initialized" | "preserved",
      MemoryHubAdministrationError
    >;
    readonly pending: (
      permit: AdminPermit,
    ) => Effect.Effect<readonly Store.AdminRecord[], MemoryHubAdministrationError>;
  }
>()("goat/memory/MemoryHubService/MemoryHubAdministrator") {}

/** @public Shares SQL/secret/settings owners without holding SQL across file writes. */
export const makeAdministrator = Effect.gen(function* () {
  const store = yield* Store.MemoryStore;
  const secrets = yield* Secrets.ServerSecretStore;
  const settings = yield* MemoryHubAdminSettings;
  const identity = yield* Environment.ServerEnvironmentIdentity;
  const encode = Schema.encodeEffect(Schema.fromJsonString(M.MemoryHubSettingsUpdateInput));
  const decode = Schema.decodeUnknownEffect(M.MemoryHubSettingsUpdateInput);
  const tx = <A, E, R>(permit: AdminPermit, effect: Effect.Effect<A, E, R>) =>
    store.transact(Effect.andThen(permit, effect));
  // Null result is the terminal refusal, not a successful settings receipt. The
  // acknowledged stage removes it from pending work and retains replay evidence.
  const retireTx = (record: Store.AdminRecord) =>
    Effect.gen(function* () {
      const activated =
        record.stage === "prepared"
          ? yield* store.writeHubAdminTx({
              record: { ...record, stage: "activated" },
              expectedStage: "prepared",
            })
          : record;
      const ready = yield* store.writeHubAdminTx({
        record: { ...activated, stage: "ready", result: null },
        expectedStage: "activated",
      });
      return yield* store.writeHubAdminTx({
        record: { ...ready, stage: "acknowledged" },
        expectedStage: "ready",
      });
    });
  // Both entry points hold the settings administration lock before entering this path.
  const updateLocked = Effect.fn("MemoryHubAdministrator.update")(function* (
    input: M.MemoryHubSettingsUpdateInput,
    permit: AdminPermit,
    initialization?: "auto-initialized",
  ) {
    const request = yield* decode(input, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => new M.MemoryHubError({ code: "invalid_output" })),
    );
    let digest = NodeCrypto.createHash("sha256")
      .update(
        (initialization ? `${initialization}:` : "") +
          (yield* encode(request).pipe(
            Effect.mapError(() => new M.MemoryHubError({ code: "invalid_output" })),
          )),
      )
      .digest("hex");
    return yield* Effect.gen(function* () {
      yield* permit;
      // Older versions activated missing-target acknowledgements before validation.
      // Finish only those no-op records, without consuming a settings revision.
      for (;;) {
        const stuck = yield* tx(permit, store.readActivatedHubAdminTx());
        if (!stuck || stuck.action.action !== "acknowledgeCredential") break;
        const target = yield* tx(permit, store.readHubAdminTx(stuck.action.credentialRequestId));
        if (target) break;
        yield* tx(
          permit,
          Effect.gen(function* () {
            const ready = yield* store.writeHubAdminTx({
              record: { ...stuck, stage: "ready" },
              expectedStage: "activated",
            });
            yield* store.writeHubAdminTx({
              record: { ...ready, stage: "acknowledged" },
              expectedStage: "ready",
            });
          }),
        );
      }
      let record = yield* tx(permit, store.readHubAdminTx(request.requestId));
      // Recovery consumes the persisted, resolved action. Accept that exact action
      // as the alias of the original null-space request; other payloads still fail.
      if (
        record &&
        record.requestDigest !== digest &&
        "action" in record &&
        record.action.action === "configure" &&
        record.action.settings.mode === "hub" &&
        request.action === "configure" &&
        request.settings.mode === "hub" &&
        request.settings.memorySpaceId === record.action.settings.memorySpaceId
      ) {
        const originalDigest = NodeCrypto.createHash("sha256")
          .update(
            yield* encode({
              ...request,
              settings: { mode: "hub", memorySpaceId: null },
            }).pipe(Effect.mapError(() => new M.MemoryHubError({ code: "invalid_output" }))),
          )
          .digest("hex");
        if (originalDigest === record.requestDigest) digest = originalDigest;
      }
      if (record && (record.requestDigest !== digest || record.initialization !== initialization))
        return yield* new Store.MemoryStoreConflict({ code: "operation_id_reused" });
      if (request.action === "acknowledgeCredential") {
        if (record?.stage === "acknowledged" && record.result === null)
          return yield* new Store.MemoryStoreConflict({ code: "not_found" });
        const original = yield* tx(permit, store.readHubAdminTx(request.credentialRequestId));
        if (
          !original ||
          (original.stage !== "ready" && original.stage !== "acknowledged") ||
          ("action" in original
            ? original.action.action !== "provisionMember" &&
              original.action.action !== "rotateMemberCredential"
            : original.memberVersion === null)
        )
          return yield* new Store.MemoryStoreConflict({ code: "not_found" });
      }
      let superseded: Store.AdminRecord | undefined;
      let preparedSuccessors: readonly Store.AdminRecord[] = [];
      let pendingScanFull = false;
      const outgoing =
        request.action === "provisionMember" || request.action === "rotateMemberCredential";
      if (!record || record.stage === "prepared") {
        const view = yield* settings.read;
        if (view.version !== request.expectedVersion)
          return yield* new Store.MemoryStoreConflict({ code: "revision_changed" });
        const activated = yield* tx(permit, store.readActivatedHubAdminTx());
        if (activated && activated.requestId !== request.requestId) {
          // A fresh owner configure reconciles the previous configure first.
          // A still-applicable CAS succeeds and forces a fresh caller revision;
          // only a refused CAS is retired. Credential operations stay protected.
          if (request.action !== "configure" || activated.action.action !== "configure")
            return yield* new Store.MemoryStoreConflict({ code: "revision_changed" });
          const result = yield* settings.apply(activated, permit).pipe(
            Effect.catchTags({
              MemoryHubError: (error) =>
                error.code === "revision_changed" ||
                (error.code === "bootstrap_required" &&
                  activated.action.action === "configure" &&
                  activated.action.settings.mode === "hub" &&
                  activated.action.settings.memorySpaceId === null)
                  ? Effect.succeed(null)
                  : Effect.fail(error),
            }),
          );
          if (result === null) superseded = activated;
          else
            yield* tx(
              permit,
              store.writeHubAdminTx({
                record: { ...activated, stage: "ready", result },
                expectedStage: "activated",
              }),
            );
          // A successful marker replay may have advanced the view; the caller
          // must still own the exact revision of its replacement request.
          if ((yield* settings.read).version !== request.expectedVersion)
            return yield* new Store.MemoryStoreConflict({ code: "revision_changed" });
        }
        if (request.action === "configure") {
          // Prepared configure intents may be the only durable pointer left
          // after their predecessor retired. Transfer that pointer before retiring
          // them, including disable/member intents carrying the internal reference.
          const pending = yield* store.readPendingHubAdmins(M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS);
          pendingScanFull = pending.length === M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS;
          preparedSuccessors = pending.filter(
            (item) =>
              item.requestId !== request.requestId &&
              item.stage === "prepared" &&
              item.action.action === "configure",
          );
        }
      }
      if (!record) {
        let previousSpace = yield* settings.readPreviousHubSpace;
        if (previousSpace === null) {
          const previousId = yield* settings.readPreviousHubRequestId;
          const previous =
            previousId === null ? undefined : yield* tx(permit, store.readHubAdminTx(previousId));
          // A disable marker points at its durable administration receipt. The
          // private reference carries a binding, not credential bytes.
          const saved = previous?.secretName?.match(/^memory-hub-internal-(.+)$/)?.[1];
          if (saved)
            previousSpace = yield* decodeMemorySpaceId(saved).pipe(
              Effect.mapError(() => new M.MemoryHubError({ code: "storage_failed" })),
            );
        }
        // Explicit request > current/previous settings (including its receipt)
        // > refused activated configure > prepared configure in Store id order
        // > new derivation. Never replace an already persisted request's action.
        for (const candidate of [...(superseded ? [superseded] : []), ...preparedSuccessors]) {
          if (previousSpace !== null) break;
          if (candidate.action.action !== "configure") continue;
          const saved =
            candidate.action.settings.mode === "hub"
              ? candidate.action.settings.memorySpaceId
              : (candidate.secretName?.match(/^memory-hub-internal-(.+)$/)?.[1] ?? null);
          if (saved !== null)
            previousSpace = yield* decodeMemorySpaceId(saved).pipe(
              Effect.mapError(() => new M.MemoryHubError({ code: "storage_failed" })),
            );
        }
        // A truncated sweep cannot prove there is no hidden recovery binding.
        // Refuse allocation rather than fork a previously published space.
        if (
          request.action === "configure" &&
          request.settings.mode === "hub" &&
          request.settings.memorySpaceId === null &&
          previousSpace === null &&
          pendingScanFull
        )
          return yield* new Store.MemoryStoreConflict({ code: "revision_changed" });
        let action: Store.PersistedAdminAction;
        if (request.action === "installCredential") {
          const { credential: _credential, ...safe } = request;
          if (!/^[A-Za-z0-9_-]{43}$/.test(request.credential))
            return yield* new M.MemoryHubError({ code: "invalid_output" });
          action = safe;
        } else if (request.action === "configure" && request.settings.mode === "hub") {
          // Persist the resolved action before SQL activation. The digest still identifies
          // the original wire request, so a retry never chooses another space.
          const hash = NodeCrypto.createHash("sha256")
            .update(
              `goat-memory-hub-space:${yield* identity.getEnvironmentId}:${request.requestId}`,
            )
            .digest("hex");
          const memorySpaceId =
            request.settings.memorySpaceId ??
            previousSpace ??
            M.MemorySpaceId.make(
              `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
            );
          action = { ...request, settings: { mode: "hub", memorySpaceId } };
        } else action = request;
        const internalSpace =
          action.action === "configure" && action.settings.mode === "hub"
            ? action.settings.memorySpaceId
            : action.action === "configure"
              ? previousSpace
              : null;
        record = yield* tx(
          permit,
          Effect.gen(function* () {
            // Keep the successor binding and retirement atomic: interruption
            // cannot leave a published space without a durable recovery pointer.
            if (superseded) yield* retireTx(superseded);
            for (const previous of preparedSuccessors) yield* retireTx(previous);
            return yield* store.writeHubAdminTx({
              record: {
                ...(initialization ? { initialization } : {}),
                requestId: request.requestId,
                requestDigest: digest,
                expectedVersion: request.expectedVersion,
                action,
                stage: "prepared",
                memberVersion: null,
                result: null,
                secretName:
                  internalSpace !== null
                    ? `memory-hub-internal-${internalSpace}`
                    : outgoing || request.action === "installCredential"
                      ? `memory-hub-${request.action === "installCredential" ? "installed" : "outgoing"}-${request.requestId}`
                      : null,
              },
              expectedStage: null,
            });
          }),
        );
        superseded = undefined;
        preparedSuccessors = [];
      }
      if (record.stage === "prepared") {
        // A historical prepared intent can have no recovery binding. Validate
        // its immutable pointer before retiring any other request's pointer.
        if (record.action.action === "configure") {
          if (record.action.settings.mode === "hub") {
            if (record.action.settings.memorySpaceId === null || record.secretName === null)
              return yield* new M.MemoryHubError({ code: "bootstrap_required" });
          } else if (superseded || preparedSuccessors.length > 0) {
            const saved = record.secretName?.match(/^memory-hub-internal-(.+)$/)?.[1];
            if (!saved) return yield* new M.MemoryHubError({ code: "bootstrap_required" });
            yield* decodeMemorySpaceId(saved).pipe(
              Effect.mapError(() => new M.MemoryHubError({ code: "bootstrap_required" })),
            );
          }
        }
        if (superseded || preparedSuccessors.length > 0)
          yield* tx(
            permit,
            Effect.gen(function* () {
              if (superseded) yield* retireTx(superseded);
              for (const previous of preparedSuccessors) yield* retireTx(previous);
            }),
          );
        yield* permit;
        if (request.action === "installCredential") {
          // Retry stages identical bytes to the same private reference.
          yield* secrets.set(record.secretName!, new TextEncoder().encode(request.credential));
        }
        if (record.action.action === "configure" && record.action.settings.mode === "hub") {
          const memorySpaceId = record.action.settings.memorySpaceId;
          if (memorySpaceId === null || record.secretName === null)
            return yield* new M.MemoryHubError({ code: "bootstrap_required" });
          const environmentId = yield* identity.getEnvironmentId;
          const existing = yield* tx(permit, store.readHubMember(memorySpaceId, environmentId));
          const credentialDigest = existing
            ? null
            : NodeCrypto.createHash("sha256")
                .update(
                  Buffer.from(yield* secrets.getOrCreateRandom(record.secretName, 32)).toString(
                    "base64url",
                  ),
                )
                .digest("hex");
          const prepared = record;
          yield* tx(
            permit,
            Effect.gen(function* () {
              const member = yield* store.readHubMember(memorySpaceId, environmentId);
              if (member) {
                // Disable preserves the published space and membership; re-enable neither
                // rotates internal authority nor publishes over a later compaction floor.
                const retention = yield* store.readHubRetentionTx(memorySpaceId);
                if (member.status !== "active" || retention.checkpointId === null)
                  return yield* new M.MemoryHubError({ code: "bootstrap_required" });
                yield* store.writeHubAdminTx({
                  record: {
                    ...prepared,
                    stage: "activated",
                    memberVersion: member.credentialVersion,
                  },
                  expectedStage: "prepared",
                });
              } else {
                if (credentialDigest === null)
                  return yield* new M.MemoryHubError({ code: "identity_mismatch" });
                yield* store.activateHubMemberTx({
                  requestId: request.requestId,
                  requestDigest: digest,
                  memorySpaceId,
                  environmentId,
                  expectedCredentialVersion: null,
                  next: { credentialDigest },
                  now: yield* Clock.currentTimeMillis,
                });
              }
            }),
          );
          record = (yield* tx(permit, store.readHubAdminTx(request.requestId)))!;
        } else if (outgoing || request.action === "revokeMember") {
          const view = yield* settings.read;
          if (view.settings.mode !== "hub" || view.settings.memorySpaceId === null)
            return yield* new M.MemoryHubError({ code: "hub_disabled" });
          const memorySpaceId = view.settings.memorySpaceId;
          const environmentId = request.environmentId;
          let credentialDigest: string | null = null;
          if (outgoing) {
            const bytes = yield* secrets.getOrCreateRandom(record.secretName!, 32);
            credentialDigest = NodeCrypto.createHash("sha256")
              .update(Buffer.from(bytes).toString("base64url"))
              .digest("hex");
          }
          yield* tx(
            permit,
            Effect.gen(function* () {
              const member = yield* store.readHubMember(memorySpaceId, environmentId);
              if (request.action === "provisionMember" && member && member.status !== "revoked")
                return yield* new Store.MemoryStoreConflict({ code: "operation_id_reused" });
              if (request.action !== "provisionMember" && !member)
                return yield* new Store.MemoryStoreConflict({ code: "not_found" });
              yield* store.activateHubMemberTx({
                requestId: request.requestId,
                requestDigest: digest,
                memorySpaceId,
                environmentId,
                expectedCredentialVersion: member?.credentialVersion ?? null,
                next:
                  credentialDigest === null
                    ? "revoked"
                    : {
                        credentialDigest,
                      },
                now: yield* Clock.currentTimeMillis,
              });
            }),
          );
          record = (yield* tx(permit, store.readHubAdminTx(request.requestId)))!;
        } else {
          record = yield* tx(
            permit,
            store.writeHubAdminTx({
              record: { ...record, stage: "activated" },
              expectedStage: "prepared",
            }),
          );
        }
      }
      if (record.stage === "activated") {
        if (request.action === "acknowledgeCredential") {
          const original = yield* tx(permit, store.readHubAdminTx(request.credentialRequestId));
          if (
            !original ||
            (original.stage !== "ready" && original.stage !== "acknowledged") ||
            ("action" in original
              ? original.action.action !== "provisionMember" &&
                original.action.action !== "rotateMemberCredential"
              : original.memberVersion === null)
          )
            return yield* new Store.MemoryStoreConflict({ code: "not_found" });
          if (original.stage === "ready" && "action" in original) {
            yield* permit;
            if (original.secretName) yield* secrets.remove(original.secretName);
            yield* tx(
              permit,
              store.writeHubAdminTx({
                record: { ...original, stage: "acknowledged" },
                expectedStage: "ready",
              }),
            );
          }
        }
        // SQL has already committed internal membership and publication. The settings
        // helper owns version/CAS and request-id replay. It receives only a persisted action and private secret name.
        const result = yield* settings.apply(record, permit);
        record = yield* tx(
          permit,
          store.writeHubAdminTx({
            record: { ...record, stage: "ready", result },
            expectedStage: "activated",
          }),
        );
      }
      if (!record.result)
        return yield* new M.MemoryHubError({
          code:
            (record.stage === "ready" || record.stage === "acknowledged") &&
            request.action === "configure"
              ? "revision_changed"
              : "bootstrap_required",
        });
      let credential: M.MemoryHubCredentialResult | null = null;
      if (outgoing && record.stage !== "acknowledged") {
        yield* permit;
        const view = record.result.view;
        if (
          view.settings.mode !== "hub" ||
          view.settings.memorySpaceId === null ||
          record.memberVersion === null
        )
          return yield* new M.MemoryHubError({ code: "identity_mismatch" });
        // Replaying a superseded rotation never discloses an obsolete credential.
        const member = yield* tx(
          permit,
          store.readHubMember(view.settings.memorySpaceId, request.environmentId),
        );
        if (
          !member ||
          member.status !== "active" ||
          member.credentialVersion !== record.memberVersion
        )
          return yield* new M.MemoryHubError({ code: "identity_mismatch" });
        const saved = yield* secrets.get(record.secretName!);
        if (Option.isNone(saved))
          return yield* new M.MemoryHubError({ code: "source_unavailable" });
        credential = {
          requestId: record.requestId,
          environmentId: request.environmentId,
          memorySpaceId: view.settings.memorySpaceId,
          credentialVersion: record.memberVersion,
          credential: Buffer.from(saved.value).toString("base64url"),
        };
      }
      // Revoke has no remote installation acknowledgement. Its committed result is
      // terminal, so it must not pin a removed member indefinitely.
      if (request.action === "revokeMember" && record.stage === "ready") {
        record = yield* tx(
          permit,
          store.writeHubAdminTx({
            record: { ...record, stage: "acknowledged" },
            expectedStage: "ready",
          }),
        );
      }
      return { view: yield* readSettingsView(store, record.result!.view), credential };
    });
  });
  const update: MemoryHubAdministrator["Service"]["update"] = (input, permit) =>
    settings.withLock(updateLocked(input, permit));
  const initializeDefaultHub = settings.withLock(
    Effect.gen(function* () {
      const hash = NodeCrypto.createHash("sha256")
        .update(`memory-default-v1:${yield* identity.getEnvironmentId}`)
        .digest("hex");
      const requestId = M.MemoryOperationId.make(
        `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
      );
      const view = yield* settings.read;
      if ((yield* settings.readPublication).state !== "current") return "preserved" as const;
      const record = yield* store.transact(store.readHubAdminTx(requestId));
      if (record && record.initialization !== "auto-initialized") return "preserved" as const;
      if (
        record?.result &&
        view.version === record.result.view.version &&
        view.provenance?.source === "auto-initialized" &&
        view.provenance.memorySpaceId === record.result.view.provenance?.memorySpaceId
      )
        return "already_initialized" as const;
      if (record?.stage === "ready" || record?.stage === "acknowledged")
        return "preserved" as const;
      const fresh = view.version === 0 && view.settings.mode === "disabled";
      const recovering =
        record?.stage === "activated" &&
        view.version === 1 &&
        view.provenance?.source === "auto-initialized" &&
        record.action.action === "configure" &&
        record.action.settings.mode === "hub" &&
        view.provenance.memorySpaceId === record.action.settings.memorySpaceId;
      if (!fresh && !recovering) return "preserved" as const;
      if (!record && (yield* store.transact(store.hasHubAdministrationTx())))
        return "preserved" as const;
      const pending = yield* store.readPendingHubAdmins(M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS);
      if (pending.some((item) => item.requestId !== requestId)) return "preserved" as const;
      // Recheck intent at recovery checkpoints; the settings lock serializes user administration.
      const permit: AdminPermit = Effect.gen(function* () {
        const current = yield* settings.read.pipe(
          Effect.mapError(() => new M.MemoryHubForbiddenError({})),
        );
        if (
          (yield* settings.readPublication).state !== "current" ||
          !(
            (current.version === 0 && current.settings.mode === "disabled") ||
            (current.version === 1 &&
              (yield* settings.readPreviousHubRequestId.pipe(
                Effect.mapError(() => new M.MemoryHubForbiddenError({})),
              )) === requestId &&
              current.provenance?.source === "auto-initialized" &&
              current.settings.mode === "hub" &&
              current.settings.memorySpaceId === current.provenance.memorySpaceId)
          )
        )
          return yield* new M.MemoryHubForbiddenError({});
      });
      yield* updateLocked(
        {
          requestId,
          expectedVersion: 0,
          action: "configure",
          settings: { mode: "hub", memorySpaceId: null },
        },
        permit,
        "auto-initialized",
      );
      return "initialized" as const;
    }),
  );
  const pending: MemoryHubAdministrator["Service"]["pending"] = Effect.fn(
    "MemoryHubAdministrator.pending",
  )((permit) =>
    Effect.andThen(permit, store.readPendingHubAdmins(M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS)),
  );
  return MemoryHubAdministrator.of({ update, pending, initializeDefaultHub });
});

export const administratorLayer = Layer.effect(MemoryHubAdministrator, makeAdministrator);

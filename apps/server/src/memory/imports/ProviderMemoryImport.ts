import * as M from "@goat/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- deterministic hashing only; identity and time are injected.
import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as Renderer from "@goat/provider-core/server/memoryContext";
import { redactMemoryText, scanMemoryValue } from "../MemorySecretScanner.ts";
import { MemoryAccessError } from "../MemoryService.ts";
import { MemoryStoreConflict } from "../MemoryStore.ts";
import type {
  ImportBatch,
  ImportCandidate,
  ImportError,
  ImportFrozenSelection,
  ImportItem,
  ImportRegistration,
  MakeProviderMemoryImport,
  Permit,
  PreparedImportCommit,
  SyncError,
} from "./MemoryImportTypes.ts";

const bytes = (s: string) => new TextEncoder().encode(s).length;
const json = (v: unknown): string => JSON.stringify(v);
const hash = (v: string) => NodeCrypto.createHash("sha256").update(v).digest("hex");
const same = NodeUtil.isDeepStrictEqual;
const scan = (values: readonly string[]) =>
  values.some((v) => scanMemoryValue(v).kind === "blocked")
    ? Effect.fail(new M.MemoryImportRpcError({ issue: "secret_detected" }))
    : Effect.void;
const syncError = (error: SyncError): ImportError => {
  if (error._tag === "MemoryHubError")
    return new M.MemoryImportRpcError({
      issue: error.code === "bootstrap_required" ? "bootstrap_required" : "storage_failed",
    });
  if (error._tag === "MemoryHubUnauthorizedError" || error._tag === "MemoryHubForbiddenError")
    return new MemoryAccessError({ code: "unavailable" });
  return error;
};
const importError = (error: ImportError): ImportError => {
  if (error._tag !== "MemoryStoreConflict") return error;
  if (error.code === "operation_id_reused")
    return new M.MemoryImportRpcError({ issue: "operation_id_reused" });
  if (error.code === "not_found") return new M.MemoryRpcError({ code: "not_found" });
  if (error.code === "bootstrap_required")
    return new M.MemoryImportRpcError({ issue: "bootstrap_required" });
  return error;
};
const frameId = "00000000-0000-4000-8000-000000000000";
/**
 * Whether the body could ever enter the turn-start memory frame: rendered alone with
 * the smallest scope an imported memory gets. False means it is stored but never
 * injected automatically, whatever scope it is mapped to.
 */
const fitsTurnStart = (text: string, address: { readonly environmentId: M.EnvironmentId }) =>
  Renderer.memoryContextFits(
    Renderer.renderMemoryContext([
      {
        memoryId: M.MemoryId.make(frameId),
        revisionId: M.MemoryRevisionId.make(frameId),
        scope: { kind: "user" },
        provenance: { environmentId: address.environmentId },
        assertionKind: "inference",
        text,
      },
    ]),
  );
const validateOutput = Schema.decodeUnknownEffect(M.MemoryImportProviderResult);
const validPayload = Schema.is(M.MemoryPayload);

/**
 * A parsed candidate as it is committed: its text redacted of GOAT credentials (an agent's note can
 * hold its thread credential, and imported memories sync, #1297) and import evidence attached. The
 * parser's fingerprints stay those of the raw source, so a re-import is still matched.
 */
export const attachImportEvidence = (
  candidate: ImportCandidate,
  sourceId: M.MemoryImportSourceId,
) => {
  const payload: M.MemoryPayload = {
    ...redactMemoryText(candidate.payload),
    evidence: [{ origin: "import", importSourceId: sourceId, messageIds: [] }],
  };
  return {
    candidate: { ...candidate, payload },
    issue:
      !validPayload(payload) || bytes(json(payload)) > M.MEMORY_PAYLOAD_MAX_UTF8_BYTES
        ? ("limit_exceeded" as const)
        : scanMemoryValue(json(payload)).kind === "blocked"
          ? ("secret_detected" as const)
          : undefined,
  };
};
const validCapacity = Schema.is(M.MemoryCapacityExceeded);

/** Closed coordinator. Reader acquisition and Service/Sync ownership stay with the composition root. */
export const makeProviderMemoryImport: MakeProviderMemoryImport = (
  ports,
  reader,
  parsers,
  primitives,
) => {
  const registration = (space: M.MemorySpaceId, sourceId: M.MemoryImportSourceId, permit: Permit) =>
    ports
      .readRegistration(
        { memorySpaceId: space, environmentId: primitives.environmentId, sourceId, by: "source" },
        permit,
      )
      .pipe(
        Effect.flatMap((r) =>
          r ? Effect.succeed(r) : Effect.fail(new M.MemoryRpcError({ code: "not_found" })),
        ),
      );
  const snapshot = (r: ImportRegistration, checkProfile = true) =>
    Effect.gen(function* () {
      const s = yield* reader.read({ slot: r.slot });
      yield* scan([
        s.sourceLocator,
        s.profile,
        s.parserVersion,
        ...s.files.flatMap((f) => [f.selector, f.text]),
      ]);
      if (
        !same(s.slot, r.slot) ||
        s.format !== r.source.format ||
        (checkProfile &&
          (s.profile !== r.source.profile || s.parserVersion !== r.source.parserVersion)) ||
        s.sourceLocator !== r.sourceLocator
      )
        return yield* new M.MemoryImportRpcError({ issue: "source_changed" });
      if (
        s.files.length > 512 ||
        s.files.reduce((n, f) => n + bytes(f.text), 0) > M.MEMORY_IMPORT_SNAPSHOT_MAX_UTF8_BYTES
      )
        return yield* new M.MemoryImportRpcError({ issue: "limit_exceeded" });
      const rows = yield* parsers[s.format](s);
      if (rows.length > M.MEMORY_IMPORT_PREVIEW_MAX_ITEMS)
        return yield* new M.MemoryImportRpcError({ issue: "limit_exceeded" });
      yield* scan(
        rows.flatMap((row) =>
          row.kind === "candidate"
            ? [row.candidate.sourceItemKey, row.candidate.title ?? "", json(row.candidate.payload)]
            : [row.sourceItemKey],
        ),
      );
      if (
        new Set(
          rows.map((row) =>
            row.kind === "candidate" ? row.candidate.sourceItemKey : row.sourceItemKey,
          ),
        ).size !== rows.length
      )
        return yield* new M.MemoryImportRpcError({ issue: "unsupported_format" });
      return { s, rows };
    });
  // Receipt status needs no source or public memory:read capability. The passed permit owns both grants.
  const finish = (action: "apply" | "status", receipt: M.MemoryImportReceipt, permit: Permit) =>
    ports.syncStatus({}, permit).pipe(
      Effect.mapError(syncError),
      Effect.map((syncStatus) => ({ action, receipt, syncStatus })),
    );
  return {
    run: (input, permit) =>
      Effect.gen(function* () {
        yield* permit;
        const address = {
          memorySpaceId: input.memorySpaceId,
          environmentId: primitives.environmentId,
        };
        if (input.action === "status")
          return yield* finish(
            "status",
            yield* ports.readReceipt({ ...address, operationId: input.operationId }, permit),
            permit,
          );
        if (input.action === "discover") {
          const slots = yield* reader.discover({ format: input.format });
          if (slots.length > 128)
            return yield* new M.MemoryImportRpcError({ issue: "limit_exceeded" });
          // Validate every descriptor before persisting any source metadata.
          yield* scan(
            slots.flatMap((s) => [
              s.label,
              s.sourceLocator,
              s.profile,
              s.parserVersion,
              s.slot.rootSlot,
              s.slot.selection ?? "",
            ]),
          );
          const sources: M.MemoryImportSource[] = [];
          for (const slot of slots) {
            if (slot.slot.format !== input.format)
              return yield* new M.MemoryImportRpcError({ issue: "unsupported_format" });
            const lookup = { ...address, by: "slot" as const, slot: slot.slot };
            let r = yield* ports.readRegistration(lookup, permit);
            if (!r) {
              const sourceId = M.MemoryImportSourceId.make(primitives.uuid());
              const next: ImportRegistration = {
                ...address,
                sourceId,
                codecVersion: 1,
                version: 0,
                slot: slot.slot,
                source: {
                  sourceId,
                  format: input.format,
                  parserVersion: slot.parserVersion,
                  profile: slot.profile,
                  label: slot.label,
                },
                sourceLocator: slot.sourceLocator,
                session: null,
              };
              r = yield* ports
                .saveRegistration({ ...address, next, expectedVersion: null }, permit)
                .pipe(
                  Effect.catchTags({
                    MemoryStoreConflict: (e) =>
                      e.code === "revision_changed"
                        ? ports
                            .readRegistration(lookup, permit)
                            .pipe(
                              Effect.flatMap((winner) =>
                                winner ? Effect.succeed(winner) : Effect.fail(e),
                              ),
                            )
                        : Effect.fail(e),
                  }),
                );
            }
            sources.push(r.source);
          }
          return { action: "discover" as const, sources };
        }
        if (input.action === "preview") {
          const r = yield* registration(input.memorySpaceId, input.sourceId, permit);
          const { s, rows } = yield* snapshot(r, false);
          const now = yield* primitives.now();
          const reuse =
            r.session &&
            r.session.snapshotDigest === s.snapshotDigest &&
            r.session.profile === s.profile &&
            r.session.parserVersion === s.parserVersion &&
            Date.parse(r.session.expiresAtUtc) > now;
          const session = reuse
            ? r.session!
            : {
                sessionId: primitives.uuid(),
                parserVersion: s.parserVersion,
                profile: s.profile,
                snapshotDigest: s.snapshotDigest,
                createdAtUtc: M.MemoryUtcTimestamp.make(
                  DateTime.formatIso(DateTime.makeUnsafe(now)),
                ),
                expiresAtUtc: M.MemoryUtcTimestamp.make(
                  DateTime.formatIso(DateTime.makeUnsafe(now + M.MEMORY_DERIVED_CACHE_TTL_MS)),
                ),
                newItems: 0,
                bodyBytes: 0,
                applied: [],
              };
          const items: M.MemoryImportPreviewItem[] = [];
          for (const row of rows) {
            if (row.kind === "rejected") {
              items.push({
                sourceItemKey: row.sourceItemKey,
                byteCount: row.byteCount,
                mappingRequired: true,
                issue: row.issue,
              });
              continue;
            }
            const c = row.candidate;
            const previous = yield* ports.readItem(
              { ...address, sourceId: r.sourceId, sourceItemKey: c.sourceItemKey },
              permit,
            );
            const match = previous
              ? yield* ports.findMatch(
                  {
                    ...address,
                    source: {
                      environmentId: address.environmentId,
                      sourceId: r.sourceId,
                      sourceItemKey: c.sourceItemKey,
                    },
                    content: {
                      scope: previous.scope,
                      assertionKind: "inference",
                      contentFingerprint: c.contentFingerprint,
                    },
                  },
                  permit,
                )
              : null;
            const suppressed = match && match.kind !== "none" && match.kind !== "live";
            const { issue } = attachImportEvidence(c, r.sourceId);
            items.push({
              sourceItemKey: c.sourceItemKey,
              sourceFingerprint: c.sourceFingerprint,
              byteCount: c.byteCount,
              mappingRequired: !previous,
              ...(previous
                ? {
                    priorOutcome: suppressed ? ("suppressed" as const) : previous.outcome,
                    memoryId: previous.memoryId,
                  }
                : {}),
              ...(c.title && !suppressed && issue !== "secret_detected" ? { title: c.title } : {}),
              ...(issue ? { issue } : {}),
              ...(input.includeTurnStartFit && !issue && !fitsTurnStart(c.payload.text, address)
                ? { tooLargeForTurnStart: true as const }
                : {}),
            });
          }
          const output = {
            action: "preview" as const,
            sourceId: r.sourceId,
            sessionId: session.sessionId,
            items,
          };
          // Refuse a complete oversized output before the CAS, without silently truncating rows.
          yield* validateOutput(output).pipe(
            Effect.mapError(() => new M.MemoryImportRpcError({ issue: "limit_exceeded" })),
          );
          yield* ports.saveRegistration(
            {
              ...address,
              expectedVersion: r.version,
              next: {
                ...r,
                source: { ...r.source, profile: s.profile, parserVersion: s.parserVersion },
                version: r.version + 1,
                session,
              },
            },
            permit,
          );
          return output;
        }
        // Canonical selection identity is independent of object-property and caller item order.
        const selectors = [...input.items].sort((a, b) =>
          a.sourceItemKey < b.sourceItemKey ? -1 : a.sourceItemKey > b.sourceItemKey ? 1 : 0,
        );
        if (new Set(selectors.map((s) => s.sourceItemKey)).size !== selectors.length)
          return yield* new M.MemoryImportRpcError({ issue: "operation_id_reused" });
        yield* scan(selectors.map((s) => s.sourceItemKey));
        const selectionDigest = hash(
          json([
            input.sourceId,
            input.sessionId,
            selectors.map((s) => [
              s.sourceItemKey,
              s.sourceFingerprint,
              s.scope.kind === "user"
                ? ["user"]
                : s.scope.kind === "project"
                  ? ["project", s.scope.projectKey]
                  : [
                      "thread",
                      s.scope.thread.environmentId,
                      s.scope.thread.threadId,
                      s.scope.projectKey ?? null,
                    ],
              s.project ? [s.project.environmentId, s.project.projectId] : null,
            ]),
          ]),
        );
        const batchAddress = { ...address, operationId: input.operationId };
        const preflight = yield* ports.preflightBatch({ ...batchAddress, selectionDigest }, permit);
        if (preflight.kind === "completed")
          return yield* finish("apply", preflight.receipt, permit);
        if (preflight.kind === "retired") return yield* new M.MemoryRpcError({ code: "not_found" });
        const readiness = yield* ports.readiness().pipe(Effect.mapError(syncError));
        if (readiness.memorySpaceId !== input.memorySpaceId || readiness.bootstrap !== "ready")
          return yield* new M.MemoryImportRpcError({ issue: "bootstrap_required" });
        yield* ports.requireBootstrap(input.memorySpaceId).pipe(Effect.mapError(syncError));
        let r = yield* registration(input.memorySpaceId, input.sourceId, permit);
        const now = yield* primitives.now();
        if (
          !r.session ||
          r.session.sessionId !== input.sessionId ||
          Date.parse(r.session.expiresAtUtc) <= now
        )
          return yield* new M.MemoryImportRpcError({ issue: "source_changed" });
        const { s, rows } = yield* snapshot(r);
        if (
          r.session.snapshotDigest !== s.snapshotDigest ||
          r.session.profile !== s.profile ||
          r.session.parserVersion !== s.parserVersion
        )
          return yield* new M.MemoryImportRpcError({ issue: "source_changed" });
        let batch: ImportBatch;
        if (preflight.kind === "partial") batch = preflight.batch;
        else {
          const selections: ImportFrozenSelection[] = [];
          for (const selector of selectors) {
            const previous = yield* ports.readItem(
              { ...address, sourceId: r.sourceId, sourceItemKey: selector.sourceItemKey },
              permit,
            );
            const row = rows.find(
              (row) =>
                row.kind === "candidate" && row.candidate.sourceItemKey === selector.sourceItemKey,
            );
            const match =
              row?.kind === "candidate"
                ? yield* ports.findMatch(
                    {
                      ...address,
                      source: {
                        environmentId: address.environmentId,
                        sourceId: r.sourceId,
                        sourceItemKey: selector.sourceItemKey,
                      },
                      content: {
                        scope: selector.scope,
                        assertionKind: "inference",
                        contentFingerprint: row.candidate.contentFingerprint,
                      },
                    },
                    permit,
                  )
                : null;
            selections.push({
              selector,
              memoryId:
                previous?.memoryId ??
                (match?.kind === "live" &&
                row?.kind === "candidate" &&
                match.payload.text === row.candidate.payload.text
                  ? match.memoryId
                  : M.MemoryId.make(primitives.uuid())),
              operationId: M.MemoryOperationId.make(primitives.uuid()),
              revisionId: M.MemoryRevisionId.make(primitives.uuid()),
              result: null,
            });
          }
          batch = {
            ...batchAddress,
            kind: "detailed",
            codecVersion: 1,
            sourceId: r.sourceId,
            sessionId: input.sessionId,
            selectionDigest,
            selections,
            createdAtUtc: M.MemoryUtcTimestamp.make(DateTime.formatIso(DateTime.makeUnsafe(now))),
            receipt: {
              operationId: input.operationId,
              sourceId: r.sourceId,
              sessionId: input.sessionId,
              sessionNewItems: r.session.newItems,
              sessionBodyBytes: r.session.bodyBytes,
              state: "partial",
              items: [],
              remaining: selections.length,
            },
          };
        }
        // Prepare every selection through read-only ports before any import commit.
        // Freeze the observed binding for materialization in the final Service transaction.
        const prepared: Omit<
          PreparedImportCommit,
          "registrationVersion" | "registration" | "batch"
        >[] = [];
        for (const frozen of batch.selections) {
          if (frozen.result) continue;
          const selector = frozen.selector;
          const row = rows.find((row) =>
            row.kind === "candidate"
              ? row.candidate.sourceItemKey === selector.sourceItemKey
              : row.sourceItemKey === selector.sourceItemKey,
          );
          if (
            !row ||
            (row.kind === "candidate" &&
              row.candidate.sourceFingerprint !== selector.sourceFingerprint)
          )
            return yield* new M.MemoryImportRpcError({ issue: "source_changed" });
          const raw: ImportCandidate =
            row.kind === "candidate"
              ? row.candidate
              : {
                  sourceItemKey: row.sourceItemKey,
                  sourceFingerprint: selector.sourceFingerprint,
                  contentFingerprint: hash(""),
                  payload: {
                    text: "Import rejected.",
                    evidence: [],
                    derivedFromMemoryRevisions: [],
                  },
                  byteCount: 0,
                };
          const attached = attachImportEvidence(raw, r.sourceId);
          if (attached.issue === "secret_detected")
            return yield* new M.MemoryImportRpcError({ issue: "secret_detected" });
          const c = attached.candidate;
          const previous =
            (yield* ports.readItem(
              { ...address, sourceId: r.sourceId, sourceItemKey: selector.sourceItemKey },
              permit,
            )) ?? null;
          if (previous && previous.memoryId !== frozen.memoryId)
            return yield* new MemoryStoreConflict({ code: "revision_changed" });
          const mappingChanged = previous !== null && !same(previous.scope, selector.scope);
          let projectBinding: M.MemoryProjectBinding | null = null;
          if (selector.project) {
            projectBinding = yield* ports.binding(
              { memorySpaceId: input.memorySpaceId, project: selector.project },
              permit,
            );
            const key = yield* ports.resolveProjectKey(input.memorySpaceId, selector.project);
            if (
              selector.scope.kind !== "project" ||
              key === null ||
              !same(key, selector.scope.projectKey) ||
              !same(projectBinding.projectKey, key)
            )
              return yield* new M.MemoryImportRpcError({ issue: "mapping_changed" });
          }
          const match = yield* ports.findMatch(
            {
              ...address,
              source: {
                environmentId: address.environmentId,
                sourceId: r.sourceId,
                sourceItemKey: c.sourceItemKey,
              },
              content: {
                scope: selector.scope,
                assertionKind: "inference",
                contentFingerprint: c.contentFingerprint,
              },
            },
            permit,
          );
          if (mappingChanged) {
            prepared.push({
              selection: frozen,
              candidate: c,
              previous,
              next: previous!,
              expectedHeads: [],
              parents: [],
              projectBinding,
              rejectOnly: { issue: "mapping_changed" },
            });
            continue;
          }
          const target = yield* ports.prepareTarget(
            {
              ...address,
              memoryId: frozen.memoryId,
              scope: selector.scope,
              acceptedRevisionId: previous?.accepted?.revisionId ?? null,
            },
            permit,
          );
          const suppressed =
            (match.kind !== "live" && match.kind !== "none") ||
            target.forgotten ||
            target.pendingForget;
          const observation = previous?.pending ?? previous?.accepted;
          const alias = target.alias?.payload.text === c.payload.text ? target.alias : null;
          const noop =
            observation &&
            target.heads.includes(observation.revisionId) &&
            observation.sourceFingerprint === c.sourceFingerprint &&
            observation.contentFingerprint === c.contentFingerprint;
          const issue = row.kind === "rejected" ? row.issue : attached.issue;
          if (!suppressed && !issue && !noop && target.acceptedParent?.status === "compacted")
            return yield* new MemoryStoreConflict({ code: "base_compacted" });
          const parents = previous?.accepted
            ? [previous.accepted.revisionId]
            : !previous?.pending && alias
              ? [alias.revision.revisionId]
              : [];
          const expectedHeads = target.heads;
          const outcome: M.MemoryImportOutcome = suppressed
            ? "suppressed"
            : issue
              ? "rejected"
              : noop
                ? "noop"
                : !previous?.accepted && !previous?.pending && alias
                  ? "aliased"
                  : previous
                    ? parents.length === expectedHeads.length &&
                      parents.every((p) => expectedHeads.includes(p))
                      ? "revised"
                      : "conflicted"
                    : "created";
          const next: ImportItem = {
            ...address,
            codecVersion: 1,
            sourceId: r.sourceId,
            sourceItemKey: c.sourceItemKey,
            scope: selector.scope,
            memoryId: frozen.memoryId,
            accepted: previous?.accepted ?? null,
            pending:
              outcome === "noop"
                ? (previous?.pending ?? null)
                : ["created", "revised", "aliased", "conflicted"].includes(outcome)
                  ? {
                      sourceFingerprint: c.sourceFingerprint,
                      contentFingerprint: c.contentFingerprint,
                      operationId: frozen.operationId,
                      revisionId: frozen.revisionId,
                    }
                  : (previous?.pending ?? null),
            rejected: issue
              ? { sourceFingerprint: c.sourceFingerprint, issue }
              : (previous?.rejected ?? null),
            outcome,
          };
          prepared.push({
            selection: frozen,
            candidate: c,
            previous,
            next,
            expectedHeads,
            parents,
            projectBinding,
          });
        }
        // Independent commits retain final Service CAS/permit checks and partial-resume semantics.
        for (const preparation of prepared) {
          const commit = (p: typeof preparation) =>
            ports.commit({ ...p, registrationVersion: r.version, registration: r, batch }, permit);
          const item = yield* commit(preparation).pipe(
            Effect.catchTags({
              MemoryCapacityError: (error) => {
                const capacity = {
                  code: "capacity_exceeded" as const,
                  dimension: error.dimension,
                  current: error.current ?? error.limit,
                  limit: error.limit,
                  reclaimable: error.reclaimable ?? 0,
                };
                // Unknown dimensions and rejection-metadata exhaustion remain typed failures.
                if (preparation.rejectOnly || !validCapacity(capacity)) return Effect.fail(error);
                return commit({
                  ...preparation,
                  next: preparation.previous ?? {
                    ...preparation.next,
                    accepted: null,
                    pending: null,
                    outcome: "rejected",
                    rejected: {
                      sourceFingerprint: preparation.candidate.sourceFingerprint,
                      issue: "capacity_exceeded",
                    },
                  },
                  rejectOnly: { issue: "capacity_exceeded", capacity },
                });
              },
            }),
          );
          batch = {
            ...batch,
            selections: batch.selections.map((s) =>
              s.selector.sourceItemKey === preparation.selection.selector.sourceItemKey
                ? { ...s, result: item }
                : s,
            ),
          };
          // Service owns observation/settlement metadata on completed selections.
          // Carry its durable batch into the next independent commit, including after ACK races.
          const current = yield* ports.preflightBatch({ ...batchAddress, selectionDigest }, permit);
          if (current.kind === "partial") batch = current.batch;
          r = yield* registration(input.memorySpaceId, input.sourceId, permit);
        }
        return yield* finish("apply", yield* ports.readReceipt(batchAddress, permit), permit);
      }).pipe(
        Effect.mapError(importError),
        Effect.flatMap((output) =>
          validateOutput(output).pipe(
            Effect.mapError(() => new M.MemoryImportRpcError({ issue: "limit_exceeded" })),
          ),
        ),
      ),
  };
};

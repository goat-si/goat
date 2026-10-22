import * as M from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { CoreReads } from "./CoreReads.ts";
import type { HubLedger } from "./HubLedger.ts";
import type { HubMembership } from "./HubMembership.ts";
import type { HubSnapshotReads } from "./HubSnapshotReads.ts";
import {
  adminActionCodec,
  adminCodec,
  adminReplayCodec,
  claimCodec,
  codec,
  fenceCodec,
  handleCodec,
  stored,
} from "./StoreCodecs.ts";
import type { StoreKernel } from "./StoreKernel.ts";
import {
  AdminRecordSchema,
  MemoryCapacityError,
  MemoryStoreConflict,
  Transaction,
  hashText,
  sameHeadSet,
  strict,
} from "./StoreModel.ts";
import type { HubMember } from "./StoreModel.ts";
import type { MemoryStoreShape } from "./StoreShape.ts";

const adminDecode = Schema.decodeUnknownEffect(AdminRecordSchema);

export const makeHubAdmin = (
  kernel: Pick<StoreKernel, "sql" | "transact">,
  coreReads: Pick<CoreReads, "loadAggregate">,
  hubSnapshotReads: Pick<HubSnapshotReads, "handlesFor">,
  hubMembership: Pick<HubMembership, "readHubMember">,
  hubLedger: Pick<HubLedger, "prepareHubCheckpointTx" | "publishCheckpointAndFloorTx">,
) => {
  const { sql, transact } = kernel;
  const { loadAggregate } = coreReads;
  const { handlesFor } = hubSnapshotReads;
  const { readHubMember } = hubMembership;
  const { prepareHubCheckpointTx, publishCheckpointAndFloorTx } = hubLedger;
  const readHubAdminTx: MemoryStoreShape["readHubAdminTx"] = Effect.fn(
    "MemoryStore.readHubAdminTx",
  )(function* (requestId) {
    yield* Transaction;
    const rows = yield* stored(
      "hub-admin-read",
      sql<{
        admin_json: string;
      }>`SELECT admin_json FROM memory_outbox WHERE id=${`admin:${requestId}`} AND kind='admin'`,
    );
    if (rows[0])
      return yield* stored("hub-admin-codec", adminCodec.decode(rows[0].admin_json, strict));
    const guards = yield* stored(
      "hub-admin-replay",
      sql<{
        record_json: string;
      }>`SELECT record_json FROM memory_import_keys WHERE space='_admin' AND key_kind='hub_admin' AND key=${requestId}`,
    );
    return guards[0] ? yield* adminReplayCodec.decode(guards[0].record_json, strict) : undefined;
  });
  const writeHubAdminTx: MemoryStoreShape["writeHubAdminTx"] = Effect.fn(
    "MemoryStore.writeHubAdminTx",
  )(function* (input) {
    yield* Transaction;
    const record = yield* stored("hub-admin-codec", adminDecode(input.record, strict));
    yield* stored(
      "hub-admin-provenance",
      sql`INSERT INTO memory_hub_administration_state(singleton,administered) VALUES(1,1) ON CONFLICT(singleton) DO UPDATE SET administered=1`,
    );
    const json = yield* stored("hub-admin-codec", adminCodec.encode(record));
    if (new TextEncoder().encode(json).length > M.MEMORY_PAGE_MAX_UTF8_BYTES)
      return yield* new MemoryStoreConflict({ code: "payload_too_large" });
    const old = yield* readHubAdminTx(record.requestId);
    if (old && !("action" in old)) {
      if (
        old.requestDigest !== record.requestDigest ||
        old.expectedVersion !== record.expectedVersion ||
        old.initialization !== record.initialization ||
        old.actionDigest !== hashText(yield* adminActionCodec.encode(record.action)) ||
        old.secretName !== record.secretName
      )
        return yield* new MemoryStoreConflict({ code: "operation_id_reused" });
      // Replay returns the original terminal result, never recreates work or a credential.
      return { ...record, stage: old.stage, result: old.result, memberVersion: old.memberVersion };
    }
    if (old) {
      if (
        old.requestDigest !== record.requestDigest ||
        old.expectedVersion !== record.expectedVersion ||
        old.initialization !== record.initialization ||
        (yield* adminActionCodec.encode(old.action)) !==
          (yield* adminActionCodec.encode(record.action)) ||
        old.secretName !== record.secretName
      )
        return yield* new MemoryStoreConflict({ code: "operation_id_reused" });
      if ((yield* adminCodec.encode(old)) === json) return old;
      const stages = ["prepared", "activated", "ready", "acknowledged"];
      if (
        old.stage !== input.expectedStage ||
        stages.indexOf(record.stage) !== stages.indexOf(old.stage) + 1 ||
        (old.memberVersion !== null && old.memberVersion !== record.memberVersion)
      )
        return yield* new MemoryStoreConflict({ code: "revision_changed" });
    } else if (
      input.expectedStage !== null ||
      record.stage !== "prepared" ||
      record.memberVersion !== null ||
      record.result !== null
    )
      return yield* new MemoryStoreConflict({ code: "revision_changed" });
    const counts = yield* stored(
      "hub-admin-budget",
      sql<{
        rows: number;
        bytes: number;
      }>`SELECT count(*) AS rows,coalesce(sum(length(CAST(admin_json AS BLOB))),0) AS bytes FROM memory_outbox WHERE kind='admin'`,
    );
    const previousBytes = old ? new TextEncoder().encode(yield* adminCodec.encode(old)).length : 0;
    if (
      counts[0]!.rows + Number(!old) > M.MEMORY_WORK_MAX_PENDING_ITEMS ||
      counts[0]!.bytes + new TextEncoder().encode(json).length - previousBytes >
        M.MEMORY_WORK_MAX_PAYLOAD_BYTES
    )
      return yield* new MemoryCapacityError({
        dimension: "work_bytes",
        limit: M.MEMORY_WORK_MAX_PAYLOAD_BYTES,
      });
    const terminalAt = record.stage === "acknowledged" ? yield* Clock.currentTimeMillis : null;
    yield* stored(
      "hub-admin-write",
      sql`INSERT INTO memory_outbox(id,space,kind,status,metadata_json,admin_json,next_attempt_at,terminal_at) VALUES (${`admin:${record.requestId}`},'_admin','admin',${record.stage === "acknowledged" ? "completed" : "pending"},'{}',${json},0,${terminalAt}) ON CONFLICT(id) DO UPDATE SET admin_json=excluded.admin_json,status=excluded.status,terminal_at=coalesce(memory_outbox.terminal_at,excluded.terminal_at)`,
    );
    return record;
  });
  const readActivatedHubAdminTx: MemoryStoreShape["readActivatedHubAdminTx"] = Effect.fn(
    "MemoryStore.readActivatedHubAdminTx",
  )(function* () {
    yield* Transaction;
    const rows = yield* stored(
      "hub-admin-activated",
      sql<{
        admin_json: string;
      }>`SELECT admin_json FROM memory_outbox WHERE kind='admin' AND admin_json IS NOT NULL AND json_extract(admin_json,'$.stage')='activated' ORDER BY id LIMIT 1`,
    );
    return rows[0]
      ? yield* stored("hub-admin-codec", adminCodec.decode(rows[0].admin_json, strict))
      : undefined;
  });
  const readPendingHubAdmins: MemoryStoreShape["readPendingHubAdmins"] = Effect.fn(
    "MemoryStore.readPendingHubAdmins",
  )(function* (limit) {
    const rows = yield* stored(
      "hub-admin-pending",
      sql<{
        admin_json: string;
      }>`SELECT admin_json FROM memory_outbox WHERE kind='admin' AND status='pending' AND admin_json IS NOT NULL ORDER BY id LIMIT ${Math.max(0, Math.min(limit, M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS))}`,
    );
    return yield* Effect.forEach(rows, (row) =>
      stored("hub-admin-codec", adminCodec.decode(row.admin_json, strict)),
    );
  });
  const activateHubMemberTx: MemoryStoreShape["activateHubMemberTx"] = Effect.fn(
    "MemoryStore.activateHubMemberTx",
  )(function* (input) {
    yield* Transaction;
    const record = yield* readHubAdminTx(input.requestId);
    if (!record || !("action" in record))
      return yield* new MemoryStoreConflict({ code: "revision_changed" });
    if (
      record.requestDigest !== input.requestDigest ||
      (record.action.action === "configure"
        ? record.action.settings.mode !== "hub" ||
          (record.action.settings.memorySpaceId !== null &&
            record.action.settings.memorySpaceId !== input.memorySpaceId)
        : !("environmentId" in record.action) ||
          record.action.environmentId !== input.environmentId)
    )
      return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
    const old = yield* readHubMember(input.memorySpaceId, input.environmentId);
    const expectedAction =
      input.next === "revoked"
        ? "revokeMember"
        : input.expectedCredentialVersion === null
          ? "provisionMember"
          : "rotateMemberCredential";
    if (
      record.action.action !== expectedAction &&
      !(
        record.action.action === "provisionMember" &&
        input.next !== "revoked" &&
        (old?.status === "revoked" || record.memberVersion !== null)
      ) &&
      !(
        record.action.action === "configure" &&
        input.next !== "revoked" &&
        input.expectedCredentialVersion === null
      )
    )
      return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
    if (record.memberVersion !== null) {
      if (
        !old ||
        old.credentialVersion !== record.memberVersion ||
        (input.next === "revoked"
          ? old.status !== "revoked"
          : old.credentialDigest !== input.next.credentialDigest || old.status !== "active")
      )
        return yield* new MemoryStoreConflict({ code: "revision_changed" });
      return old;
    }
    if (
      record.stage !== "prepared" ||
      (old?.credentialVersion ?? null) !== input.expectedCredentialVersion ||
      (input.next === "revoked" && !old)
    )
      return yield* new MemoryStoreConflict({ code: "revision_changed" });
    if (input.next !== "revoked" && !/^[a-f0-9]{64}$/.test(input.next.credentialDigest))
      return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
    // Allocate before reclaiming: this one durable space counter survives deleted
    // identities, seeds from legacy members, and rolls back with activation.
    const versions = yield* stored(
      "hub-member-version",
      sql<{ version: number }>`SELECT max(
        coalesce((SELECT value FROM memory_quota_counters WHERE space=${input.memorySpaceId}
          AND dimension='hub_member_version' AND scope_key=''),0),
        coalesce((SELECT max(credential_version) FROM memory_hub_members WHERE space=${input.memorySpaceId}),0)
      ) AS version`,
    );
    const version = versions[0]!.version + 1;
    if (!Number.isSafeInteger(version))
      return yield* new MemoryStoreConflict({ code: "revision_changed" });
    yield* stored(
      "hub-member-version-write",
      sql`INSERT INTO memory_quota_counters(space,dimension,scope_key,value)
        VALUES (${input.memorySpaceId},'hub_member_version','',${version})
        ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=excluded.value`,
    );
    const count = yield* stored(
      "hub-member-count",
      sql<{
        count: number;
      }>`SELECT count(*) AS count FROM memory_hub_members WHERE space=${input.memorySpaceId}`,
    );
    if (!old && count[0]!.count >= M.MEMORY_HUB_MAX_MEMBERS) {
      // Older ready revokes already committed both SQL authority and settings.
      // They have no install step; finish them here as well as on the normal path.
      yield* stored(
        "hub-member-settle-revokes",
        sql`UPDATE memory_outbox SET status='completed',terminal_at=coalesce(terminal_at,${input.now}),
          admin_json=json_set(admin_json,'$.stage','acknowledged')
          WHERE kind='admin' AND status='pending' AND json_extract(admin_json,'$.stage')='ready'
            AND json_extract(admin_json,'$.action.action')='revokeMember'
            AND json_extract(admin_json,'$.result.view.settings.memorySpaceId')=${input.memorySpaceId}`,
      );
      // Revoked authority cannot authenticate. Keep any row that still anchors live
      // work. A ready outgoing receipt below the revoked version is already
      // superseded: replay cannot activate or disclose it. Its guard stays bounded.
      yield* stored(
        "hub-member-reclaim",
        sql`DELETE FROM memory_hub_members AS m WHERE m.space=${input.memorySpaceId} AND m.status='revoked'
          AND NOT EXISTS (SELECT 1 FROM memory_outbox o WHERE o.kind='admin' AND o.status!='completed'
            AND ((json_extract(o.admin_json,'$.action.environmentId')=m.environment
              AND NOT (json_extract(o.admin_json,'$.stage')='ready'
                AND json_extract(o.admin_json,'$.action.action') IN ('provisionMember','rotateMemberCredential')
                AND coalesce(json_extract(o.admin_json,'$.memberVersion'),m.credential_version)<m.credential_version))
              OR (json_extract(o.admin_json,'$.action.action')='configure'
                AND json_extract(o.admin_json,'$.stage') IN ('prepared','activated'))))
          AND NOT EXISTS (SELECT 1 FROM memory_hub_leases l WHERE l.space=m.space
            AND json_extract(l.lease_json,'$.holderEnvironmentId')=m.environment
            AND l.lease_json IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM memory_hub_retention r,json_each(r.handles_json) h
            WHERE r.space=m.space AND json_extract(h.value,'$.memberEnvironmentId')=m.environment
              AND json_extract(h.value,'$.expiresAt')>${input.now})
          AND NOT EXISTS (SELECT 1 FROM memory_import_keys k WHERE k.space=m.space
            AND k.key_kind='hub_checkpoint_token'
            AND json_extract(k.record_json,'$.handle.memberEnvironmentId')=m.environment
            AND json_extract(k.record_json,'$.retired')=0
            AND json_extract(k.record_json,'$.handle.expiresAt')>${input.now})
          AND NOT EXISTS (SELECT 1 FROM memory_hub_source_reads r WHERE r.space=m.space
            AND (r.requester=m.environment OR r.owner=m.environment)
            AND r.state='pending' AND r.deadline>${input.now})`,
      );
      // Revoke/rotation already expired every relay for these identities. The
      // durable version high-water above prevents reenrollment from reviving them.
      // Keep pair fences only while both member rows exist, in this same writer Tx.
      yield* stored(
        "hub-source-fence-reclaim-owners",
        sql`DELETE FROM memory_import_keys AS f WHERE f.space=${input.memorySpaceId}
          AND f.key_kind='hub_source_fences' AND NOT EXISTS
            (SELECT 1 FROM memory_hub_members m WHERE m.space=f.space AND m.environment=f.key)`,
      );
      yield* stored(
        "hub-source-fence-reclaim-requesters",
        sql`UPDATE memory_import_keys AS f SET record_json=(
          SELECT json_group_array(json(p.value)) FROM json_each(f.record_json) p
          WHERE EXISTS (SELECT 1 FROM memory_hub_members m WHERE m.space=f.space
            AND m.environment=json_extract(p.value,'$.requesterEnvironmentId')))
          WHERE f.space=${input.memorySpaceId} AND f.key_kind='hub_source_fences'`,
      );
      const remaining = yield* stored(
        "hub-member-count-after-reclaim",
        sql<{
          count: number;
        }>`SELECT count(*) AS count FROM memory_hub_members WHERE space=${input.memorySpaceId}`,
      );
      if (remaining[0]!.count >= M.MEMORY_HUB_MAX_MEMBERS)
        return yield* new MemoryCapacityError({
          dimension: "members",
          limit: M.MEMORY_HUB_MAX_MEMBERS,
          current: remaining[0]!.count,
          reclaimable: 0,
        });
    }
    const next: HubMember = {
      memorySpaceId: input.memorySpaceId,
      environmentId: input.environmentId,
      credentialDigest:
        input.next === "revoked" ? old!.credentialDigest : input.next.credentialDigest,
      credentialVersion: version,
      status: input.next === "revoked" ? "revoked" : "active",
      joinedAt: old?.joinedAt ?? input.now,
    };
    yield* stored(
      "hub-member-activate",
      sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status,joined_at) VALUES (${next.memorySpaceId},${next.environmentId},${next.credentialDigest},${next.credentialVersion},${next.status},${next.joinedAt}) ON CONFLICT(space,environment) DO UPDATE SET credential_digest=excluded.credential_digest,credential_version=excluded.credential_version,status=excluded.status`,
    );
    // Rotation/revoke fences both ledgers before the new credential can authorize a request.
    const leases = yield* stored(
      "hub-member-leases",
      sql<{
        memory_id: string;
        highest_token: number;
      }>`SELECT memory_id,highest_token FROM memory_hub_leases WHERE space=${input.memorySpaceId} AND json_extract(lease_json,'$.holderEnvironmentId')=${input.environmentId}`,
    );
    for (const lease of leases) {
      const aggregate = yield* loadAggregate(
        input.memorySpaceId,
        M.MemoryId.make(lease.memory_id),
        {},
        {},
      );
      const highest = Math.max(lease.highest_token, aggregate.fence?.highestFencingToken ?? 0) + 1;
      const fence: M.MemoryFenceRecord = {
        memorySpaceId: input.memorySpaceId,
        memoryId: M.MemoryId.make(lease.memory_id),
        highestFencingToken: highest,
        activeLease: null,
      };
      yield* stored(
        "hub-member-invalidate",
        sql`UPDATE memory_hub_leases SET highest_token=${highest},lease_json=NULL WHERE space=${input.memorySpaceId} AND memory_id=${lease.memory_id}`,
      );
      yield* stored(
        "hub-member-fence",
        sql`UPDATE memory_identity_ledger SET fence_json=${yield* fenceCodec.encode(fence)} WHERE space=${input.memorySpaceId} AND memory_id=${lease.memory_id}`,
      );
    }
    const relay = yield* stored(
      "hub-member-relay",
      sql<{
        payload_ref: string | null;
      }>`SELECT payload_ref FROM memory_hub_source_reads WHERE space=${input.memorySpaceId} AND (requester=${input.environmentId} OR owner=${input.environmentId})`,
    );
    for (const row of relay)
      if (row.payload_ref)
        yield* stored(
          "hub-member-relay-purge",
          sql`DELETE FROM memory_payloads WHERE space=${input.memorySpaceId} AND payload_ref=${row.payload_ref}`,
        );
    yield* stored(
      "hub-member-relay-delete",
      sql`UPDATE memory_hub_source_reads SET state='expired',locator_json='{}',payload_ref=NULL WHERE space=${input.memorySpaceId} AND (requester=${input.environmentId} OR owner=${input.environmentId})`,
    );
    const previousHandles = yield* handlesFor(input.memorySpaceId);
    for (const handle of previousHandles.filter(
      (h) => h.memberEnvironmentId === input.environmentId,
    ))
      yield* stored(
        "hub-member-token-retire",
        sql`UPDATE memory_import_keys SET record_json=json_set(record_json,'$.retired',json('true')) WHERE space=${input.memorySpaceId} AND key_kind='hub_checkpoint_token' AND key=${hashText(handle.snapshotToken)}`,
      );
    yield* stored(
      "hub-member-pin-retire",
      sql`UPDATE memory_hub_retention SET handles_json=${yield* handleCodec.encode(previousHandles.filter((h) => h.memberEnvironmentId !== input.environmentId))} WHERE space=${input.memorySpaceId}`,
    );
    if (record.action.action === "configure") {
      // Readiness and internal authority commit together; a nonrepresentable legacy space rolls back.
      const checkpoint = yield* prepareHubCheckpointTx({
        authority: {
          principal: {
            memorySpaceId: input.memorySpaceId,
            environmentId: input.environmentId,
            credentialVersion: next.credentialVersion,
            scopes: ["memory:sync"],
          },
          now: Effect.succeed(input.now),
          reauthorize: Effect.void,
        },
        checkpointId: `initial-${input.requestId}`,
        snapshotToken: `initial-${input.requestId}`,
        hubEnvironmentId: input.environmentId,
      }).pipe(
        Effect.catchTags({
          MemoryHubError: () =>
            Effect.fail(new MemoryStoreConflict({ code: "bootstrap_required" })),
          MemoryHubUnauthorizedError: () =>
            Effect.fail(new MemoryStoreConflict({ code: "identity_mismatch" })),
          MemoryHubForbiddenError: () =>
            Effect.fail(new MemoryStoreConflict({ code: "identity_mismatch" })),
        }),
      );
      yield* publishCheckpointAndFloorTx({
        memorySpaceId: input.memorySpaceId,
        checkpointId: checkpoint.checkpointId,
        expectedFloor: 0,
        nextFloor: checkpoint.checkpointSequence,
        now: input.now,
      });
      yield* stored(
        "hub-internal-pin-retire",
        sql`UPDATE memory_hub_retention SET handles_json='[]' WHERE space=${input.memorySpaceId}`,
      );
      yield* stored(
        "hub-internal-token-retire",
        sql`UPDATE memory_import_keys SET record_json=json_set(record_json,'$.retired',json('true')) WHERE space=${input.memorySpaceId} AND key_kind='hub_checkpoint_token' AND key=${hashText(checkpoint.snapshotToken)}`,
      );
    }
    yield* writeHubAdminTx({
      record: { ...record, stage: "activated", memberVersion: next.credentialVersion },
      expectedStage: "prepared",
    });
    return next;
  });
  const readProcessingFor = Effect.fn("MemoryStore.readProcessingFor")(function* (input: {
    space: string;
    binding: { memorySpaceId: M.MemorySpaceId; hubEnvironmentId: M.EnvironmentId } | null;
  }) {
    return yield* transact(
      Effect.gen(function* () {
        const rows = yield* stored(
          "processing-counters",
          sql<{
            dimension: string;
            value: number;
          }>`SELECT dimension,value FROM memory_quota_counters WHERE space=${input.space} AND scope_key='' AND dimension IN ('processing_quarantined','processing_eligible','processing_indexed','processing_cleanup','processing_scanner_held','processing_scanner_pending','processing_missing_parent','processing_deferred','processing_pending_sync','processing_parked','processing_report_backlog','processing_report_failed','processing_admission_failures')`,
        );
        const values = new Map(rows.map((r) => [r.dimension, r.value]));
        const count = (name: string) => values.get(`processing_${name}`) ?? 0;
        const oldest = yield* stored(
          "processing-oldest",
          sql<{
            processing_oldest_at: string;
          }>`SELECT processing_oldest_at FROM memory_items WHERE space=${input.space} AND processing_oldest_at IS NOT NULL ORDER BY processing_oldest_at LIMIT 1`,
        );
        const sequence = input.binding ? (yield* readBootstrap(input.binding)).afterSequence : 0;
        const state = yield* stored(
          "processing-watermark",
          sql<{
            projection_watermark: number;
          }>`SELECT projection_watermark FROM memory_compaction_state WHERE space=${input.space}`,
        );
        const eligible = count("eligible");
        const indexed = count("indexed");
        const processing = yield* stored(
          "processing-codec",
          codec(M.MemoryProcessingStatus).decode(
            yield* codec(M.MemoryProcessingStatus).encode({
              lastReceivedHubSequence: sequence,
              receiveLag: null,
              deferred: count("deferred"),
              oldestDeferredAtUtc: oldest[0]
                ? M.MemoryUtcTimestamp.make(oldest[0].processing_oldest_at)
                : null,
              unindexedItems: eligible - indexed,
              scannerHeldItems: count("scanner_held"),
              scannerPendingItems: count("scanner_pending"),
              missingParentItems: count("missing_parent"),
              pendingCleanupItems: count("cleanup"),
              reportBacklog: count("report_backlog"),
              reportFailed: count("report_failed"),
              hubAdmissionFailures: count("admission_failures"),
              indexCoverage: {
                status:
                  eligible === indexed ? "available" : indexed === 0 ? "unavailable" : "partial",
                eligibleItems: eligible,
                indexedItems: indexed,
                unindexedItems: eligible - indexed,
                projectionWatermark: state[0]?.projection_watermark ?? 0,
              },
            }),
            strict,
          ),
        );
        return {
          processing,
          pendingSync: count("pending_sync"),
          quarantined: count("quarantined"),
          parked: count("parked"),
        };
      }),
    );
  });
  const readProcessing: MemoryStoreShape["readProcessing"] = (input) =>
    readProcessingFor({ space: input.memorySpaceId, binding: input });
  const readLocalProcessingStatus: MemoryStoreShape["readLocalProcessingStatus"] = (input) =>
    readProcessingFor({
      // WP2 drafts use an internal key, never a protocol MemorySpaceId or a new space.
      space: input.memorySpaceId ?? `_local:${input.environmentId}`,
      binding:
        input.memorySpaceId !== null && input.hubEnvironmentId !== null
          ? { memorySpaceId: input.memorySpaceId, hubEnvironmentId: input.hubEnvironmentId }
          : null,
    });
  const readBootstrap: MemoryStoreShape["readBootstrap"] = Effect.fn("MemoryStore.readBootstrap")(
    function* (input) {
      const rows = yield* stored(
        "bootstrap-read",
        sql<{
          bootstrap_state: "unbound" | "staging" | "ready";
          checkpoint_id: string | null;
          snapshot_token: string | null;
          checkpoint_sequence: number | null;
          checkpoint_cursor: string | null;
          checkpoint_page_count: number;
          after_sequence: number;
          last_success_at: number | null;
        }>`SELECT bootstrap_state,checkpoint_id,snapshot_token,checkpoint_sequence,checkpoint_cursor,checkpoint_page_count,after_sequence,last_success_at FROM memory_sync_cursors WHERE space=${input.memorySpaceId} AND hub_environment_id=${input.hubEnvironmentId}`,
      );
      const row = rows[0];
      return {
        state: row?.bootstrap_state ?? "unbound",
        checkpointId: row?.checkpoint_id ?? null,
        snapshotToken: row?.snapshot_token ?? null,
        checkpointSequence: row?.checkpoint_sequence ?? 0,
        cursor: row?.checkpoint_cursor ?? null,
        pageCount: row?.checkpoint_page_count ?? 0,
        afterSequence: row?.after_sequence ?? 0,
        lastSuccessAt: row?.last_success_at ?? null,
      };
    },
  );
  const discardBootstrapTx: MemoryStoreShape["discardBootstrapTx"] = Effect.fn(
    "MemoryStore.discardBootstrapTx",
  )(function* (input) {
    yield* Transaction;
    const changed = yield* stored(
      "bootstrap-discard-cas",
      sql`UPDATE memory_sync_cursors SET bootstrap_state='unbound',checkpoint_id=NULL,snapshot_token=NULL,checkpoint_sequence=NULL,checkpoint_cursor=NULL,checkpoint_page_count=0,after_sequence=0,last_success_at=NULL WHERE space=${input.memorySpaceId} AND hub_environment_id=${input.hubEnvironmentId} AND bootstrap_state='staging' AND snapshot_token=${input.expectedSnapshotToken} AND checkpoint_id=${input.expectedCheckpointId} AND checkpoint_sequence=${input.expectedCheckpointSequence} RETURNING space`,
    );
    if (!changed.length) return false;
    yield* stored(
      "bootstrap-discard-pages",
      sql`DELETE FROM memory_inbox_pending WHERE space=${input.memorySpaceId} AND checkpoint_id=${input.expectedCheckpointId} AND record_kind='checkpoint'`,
    );
    // Only rows created by this staging attempt are reclaimable. A concurrent
    // canonical receive may already have adopted the same payload reference.
    yield* stored(
      "bootstrap-discard-bodies",
      sql`DELETE FROM memory_payloads WHERE space=${input.memorySpaceId} AND checkpoint_stage_id=${input.expectedCheckpointId} AND NOT EXISTS(SELECT 1 FROM memory_revisions r WHERE r.space=memory_payloads.space AND r.payload_ref=memory_payloads.payload_ref) AND NOT EXISTS(SELECT 1 FROM memory_resolutions r WHERE r.space=memory_payloads.space AND r.judgment_payload_ref=memory_payloads.payload_ref) AND NOT EXISTS(SELECT 1 FROM memory_outbox o WHERE o.space=memory_payloads.space AND o.payload_ref=memory_payloads.payload_ref)`,
    );
    yield* stored(
      "bootstrap-discard-adopted",
      sql`UPDATE memory_payloads SET checkpoint_stage_id=NULL WHERE space=${input.memorySpaceId} AND checkpoint_stage_id=${input.expectedCheckpointId}`,
    );
    return true;
  });
  const retireFrozenClaimTx: MemoryStoreShape["retireFrozenClaimTx"] = Effect.fn(
    "MemoryStore.retireFrozenClaimTx",
  )(function* (input) {
    yield* Transaction;
    const rows = yield* stored(
      "frozen-claim-read",
      sql<{
        frozen_claim_json: string;
      }>`SELECT frozen_claim_json FROM memory_outbox WHERE id=${input.candidateId} AND space=${input.memorySpaceId} AND kind='claim' AND sync_version=${input.expectedGeneration} AND frozen_claim_json IS NOT NULL AND status IN ('pending','retry','running')`,
    );
    if (!rows[0]) return false;
    const claim = yield* stored(
      "frozen-claim-decode",
      claimCodec.decode(rows[0].frozen_claim_json, strict),
    );
    if (
      claim.attemptId !== input.attemptId ||
      !sameHeadSet(claim.conflictHeadSet, input.frozenHeads)
    )
      return false;
    const changed = yield* stored(
      "frozen-claim-retire",
      sql`UPDATE memory_outbox SET frozen_claim_json=NULL,sync_version=sync_version+1,status='retry',claimed_by=NULL,claimed_until=NULL,next_attempt_at=${input.nextAttemptAt} WHERE id=${input.candidateId} AND space=${input.memorySpaceId} AND kind='claim' AND sync_version=${input.expectedGeneration} AND frozen_claim_json=${rows[0].frozen_claim_json} AND NOT EXISTS(SELECT 1 FROM memory_outbox t WHERE t.space=${input.memorySpaceId} AND t.kind='resolve' AND json_extract(t.ticket_json,'$.ticket.attemptId')=${input.attemptId}) RETURNING id`,
    );
    return changed.length === 1;
  });
  const advanceBootstrapTx: MemoryStoreShape["advanceBootstrapTx"] = Effect.fn(
    "MemoryStore.advanceBootstrapTx",
  )(function* (input) {
    yield* Transaction;
    if (input.expectedState === "unbound" && input.nextState !== "staging")
      return yield* new MemoryStoreConflict({ code: "bootstrap_required" });
    yield* stored(
      "bootstrap-init",
      sql`INSERT INTO memory_sync_cursors(space,hub_environment_id,after_sequence,bootstrap_state) VALUES (${input.memorySpaceId},${input.hubEnvironmentId},0,'unbound') ON CONFLICT(space,hub_environment_id) DO NOTHING`,
    );
    if (input.nextState === "ready") {
      const published = yield* stored(
        "bootstrap-published",
        sql`SELECT 1 FROM memory_compaction_state WHERE space=${input.memorySpaceId} AND checkpoint_id=${input.checkpointId} AND published=1 AND json_extract(boundary_json,'$.checkpointSequence')=${input.checkpointSequence}`,
      );
      if (!published.length || input.nextCursor !== null)
        return yield* new MemoryStoreConflict({ code: "bootstrap_required" });
    }
    const changed = yield* stored(
      "bootstrap-cas",
      sql`UPDATE memory_sync_cursors SET bootstrap_state=${input.nextState},checkpoint_id=${input.checkpointId},snapshot_token=${input.snapshotToken},checkpoint_sequence=${input.checkpointSequence},checkpoint_cursor=${input.nextCursor},after_sequence=CASE WHEN ${input.nextState}='ready' THEN max(after_sequence,${input.checkpointSequence}) ELSE after_sequence END WHERE space=${input.memorySpaceId} AND hub_environment_id=${input.hubEnvironmentId} AND bootstrap_state=${input.expectedState} AND (${input.expectedState}!='staging' OR checkpoint_id=${input.checkpointId} AND snapshot_token IS ${input.snapshotToken} AND checkpoint_sequence=${input.checkpointSequence}) RETURNING space`,
    );
    if (!changed.length) return yield* new MemoryStoreConflict({ code: "revision_changed" });
  });
  return {
    readHubAdminTx,
    writeHubAdminTx,
    readActivatedHubAdminTx,
    readPendingHubAdmins,
    activateHubMemberTx,
    readProcessing,
    readLocalProcessingStatus,
    readBootstrap,
    discardBootstrapTx,
    retireFrozenClaimTx,
    advanceBootstrapTx,
  };
};

export type HubAdmin = ReturnType<typeof makeHubAdmin>;

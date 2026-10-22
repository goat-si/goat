import { scanMemoryValue } from "../MemorySecretScanner.ts";
import * as M from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { CoreReads } from "./CoreReads.ts";
import type { HubLedger } from "./HubLedger.ts";
import type { HubMembership } from "./HubMembership.ts";
import type { HubSnapshotReads } from "./HubSnapshotReads.ts";
import {
  adminCodec,
  adminReplayJson,
  codec,
  handleCodec,
  snapshotId,
  stored,
  stringArrayCodec,
} from "./StoreCodecs.ts";
import type { StoreKernel } from "./StoreKernel.ts";
import { MemoryCapacityError, Transaction, hashText, strict } from "./StoreModel.ts";
import type { MemoryStoreShape } from "./StoreShape.ts";

const sourceRequestCodec = codec(M.MemorySourceReadRequest);
const sourceInputCodec = codec(M.MemoryHubSourceReadRequestInput);
const sourceOutcomeCodec = codec(M.MemorySourceReadOutcome);
const sourceRespondCodec = codec(M.MemoryHubSourceReadRespondInput);
const sourceCollectCodec = codec(M.MemoryHubSourceReadCollectResult);
const sourceThreadCodec = codec(M.ScopedThreadRef);
const sourceWatermarkCodec = codec(M.MemorySourceWatermark);
// Relay authority metadata shares the existing body-free replay registry. One
// bounded map per retained member; membership reclamation prunes both ends.
const pairFencesCodec = codec(M.MemorySourceReadPairFences);
const settlementCodec = codec(
  Schema.Struct({
    responseDigest: Schema.NullOr(Schema.String),
    ownerPolicyEpoch: M.MemoryOwnerPolicyEpoch,
    denied: Schema.Boolean,
  }),
);
type RelayRow = {
  request_id: string;
  memory_id: string;
  requester: string;
  owner: string;
  credential_version: number;
  request_digest: string;
  locator_json: string;
  state: "pending" | "completed" | "expired";
  deadline: number;
  response_digest: string | null;
  payload_ref: string | null;
};
const relayRequest = Effect.fnUntraced(function* (space: M.MemorySpaceId, row: RelayRow) {
  const request = yield* sourceRequestCodec
    .decode(row.locator_json, strict)
    .pipe(Effect.orElseSucceed(() => null));
  if (
    !request?.stamp ||
    request.memorySpaceId !== space ||
    request.requestId !== row.request_id ||
    request.memoryId !== row.memory_id ||
    request.sourceThread.environmentId !== row.owner ||
    request.requesterEnvironmentId !== row.requester ||
    request.stamp.requesterCredentialVersion !== row.credential_version ||
    request.stamp.locatorDigest !== row.request_digest ||
    Date.parse(request.expiresAtHubTime) !== row.deadline
  )
    return null;
  const {
    stamp: _stamp,
    requesterEnvironmentId: _requester,
    expiresAtHubTime: _expiry,
    ...locator
  } = request;
  const digest = hashText(yield* sourceInputCodec.encode({ protocolVersion: 1, ...locator }));
  return digest === row.request_digest ? request : null;
});

export const makeSourceReads = (
  kernel: Pick<StoreKernel, "sql">,
  coreReads: Pick<CoreReads, "loadAggregate">,
  hubSnapshotReads: Pick<HubSnapshotReads, "handlesFor">,
  hubMembership: Pick<HubMembership, "authorizeSource" | "readHubMember">,
  hubLedger: Pick<HubLedger, "readHubRetentionTx">,
) => {
  const { sql } = kernel;
  const { loadAggregate } = coreReads;
  const { handlesFor } = hubSnapshotReads;
  const { authorizeSource, readHubMember } = hubMembership;
  const { readHubRetentionTx } = hubLedger;
  const readPairFences = Effect.fnUntraced(function* (
    space: M.MemorySpaceId,
    owner: M.EnvironmentId,
  ) {
    const rows = yield* stored(
      "relay-pair-fences",
      sql<{
        record_json: string;
      }>`SELECT record_json FROM memory_import_keys WHERE space=${space} AND key_kind='hub_source_fences' AND key=${owner}`,
    );
    const fences = rows[0] ? yield* pairFencesCodec.decode(rows[0].record_json, strict) : [];
    if (fences.some((f) => f.memorySpaceId !== space || f.ownerEnvironmentId !== owner))
      return yield* new M.MemoryHubError({ code: "identity_mismatch" });
    return fences;
  });
  const pairFence = Effect.fnUntraced(function* (space: M.MemorySpaceId, row: RelayRow) {
    return (
      (yield* readPairFences(space, M.EnvironmentId.make(row.owner))).find(
        (f) => f.requesterEnvironmentId === row.requester,
      )?.revokedThroughEpoch ?? -1
    );
  });
  const readRelay = Effect.fnUntraced(function* (
    space: M.MemorySpaceId,
    requestId: M.MemorySourceReadRequestId,
  ) {
    const rows = yield* stored(
      "relay-read",
      sql<RelayRow>`SELECT request_id,memory_id,requester,owner,credential_version,request_digest,locator_json,state,deadline,response_digest,payload_ref FROM memory_hub_source_reads WHERE space=${space} AND request_id=${requestId}`,
    );
    return rows[0];
  });
  const relayEligible = Effect.fnUntraced(function* (
    space: M.MemorySpaceId,
    request: M.MemorySourceReadRequest,
  ) {
    const aggregate = yield* loadAggregate(space, request.memoryId, { heads: true }, {});
    if (aggregate.tombstone || aggregate.pendingForget) return false;
    if (!aggregate.item || aggregate.item.localAvailability.exposure !== "visible") return false;
    for (const pair of aggregate.revisions) {
      if (!aggregate.heads.includes(pair.revision.revisionId) || !pair.payload) continue;
      const provenance = pair.revision.provenance;
      if (!provenance.sourceThread || !provenance.sourceWatermark) continue;
      if (
        (yield* sourceThreadCodec.encode(provenance.sourceThread)) !==
          (yield* sourceThreadCodec.encode(request.sourceThread)) ||
        (yield* sourceWatermarkCodec.encode(provenance.sourceWatermark)) !==
          (yield* sourceWatermarkCodec.encode(request.sourceWatermark))
      )
        continue;
      const evidence = new Set(
        pair.payload.evidence
          .filter(
            (value) =>
              value.origin === "thread" &&
              value.sourceThread?.environmentId === request.sourceThread.environmentId &&
              value.sourceThread.threadId === request.sourceThread.threadId &&
              value.watermark?.fromEventId === provenance.sourceWatermark?.fromEventId &&
              value.watermark?.toEventId === provenance.sourceWatermark?.toEventId &&
              value.watermark?.throughSequence === provenance.sourceWatermark?.throughSequence,
          )
          .flatMap((value) => value.messageIds),
      );
      if (request.messageIds.every((id) => evidence.has(id))) return true;
    }
    return false;
  });
  const eraseRelayPayload = Effect.fnUntraced(function* (space: M.MemorySpaceId, row: RelayRow) {
    if (row.payload_ref)
      yield* stored(
        "relay-payload-purge",
        sql`DELETE FROM memory_payloads WHERE space=${space} AND payload_ref=${row.payload_ref}`,
      );
    yield* stored(
      "relay-expire",
      sql`UPDATE memory_hub_source_reads SET state='expired',locator_json='{}',payload_ref=NULL WHERE space=${space} AND request_id=${row.request_id}`,
    );
  });
  const settleDenied = Effect.fnUntraced(function* (
    space: M.MemorySpaceId,
    row: RelayRow,
    epoch: number,
  ) {
    if (row.payload_ref)
      yield* stored(
        "relay-denied-purge",
        sql`DELETE FROM memory_payloads WHERE space=${space} AND payload_ref=${row.payload_ref}`,
      );
    yield* stored(
      "relay-denied",
      sql`UPDATE memory_hub_source_reads SET state='completed',payload_ref=NULL,response_digest=${yield* settlementCodec.encode({ responseDigest: null, ownerPolicyEpoch: epoch, denied: true })} WHERE space=${space} AND request_id=${row.request_id}`,
    );
  });
  const compactTerminalAdmins = Effect.fnUntraced(function* (now: number, limit: number) {
    const rows = yield* stored(
      "hub-admin-sweep",
      sql<{
        id: string;
        admin_json: string;
      }>`SELECT id,admin_json FROM memory_outbox WHERE kind='admin' AND status='completed' AND terminal_at<=${now - M.MEMORY_LOG_RETENTION_MS} AND json_extract(admin_json,'$.stage')='acknowledged' ORDER BY terminal_at,id LIMIT ${limit + 1}`,
    );
    for (const row of rows.slice(0, limit)) {
      const record = yield* adminCodec.decode(row.admin_json, strict);
      yield* stored(
        "hub-admin-guard",
        sql`INSERT INTO memory_import_keys(space,key_kind,key,memory_id,record_json) VALUES ('_admin','hub_admin',${record.requestId},${record.requestId},${yield* adminReplayJson(record)}) ON CONFLICT(space,key_kind,key) DO NOTHING`,
      );
      yield* stored("hub-admin-detail-retire", sql`DELETE FROM memory_outbox WHERE id=${row.id}`);
    }
    return { removedRows: Math.min(rows.length, limit), cleanupPending: rows.length > limit };
  });
  const purgeHubTransientTx: MemoryStoreShape["purgeHubTransientTx"] = Effect.fn(
    "MemoryStore.purgeHubTransientTx",
  )(function* (input) {
    yield* Transaction;
    const limit = Math.max(0, Math.min(input.limit, M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS));
    const rows = yield* stored(
      "relay-sweep",
      sql<RelayRow>`SELECT request_id,memory_id,requester,owner,credential_version,request_digest,locator_json,state,deadline,response_digest,payload_ref FROM memory_hub_source_reads WHERE space=${input.memorySpaceId} AND (deadline<=${input.now} OR (${input.memoryId ?? null} IS NOT NULL AND memory_id=${input.memoryId ?? null})) ORDER BY deadline,request_id LIMIT ${limit + 1}`,
    );
    for (const row of rows.slice(0, limit)) {
      yield* eraseRelayPayload(input.memorySpaceId, row);
      yield* stored(
        "relay-sweep-delete",
        sql`DELETE FROM memory_hub_source_reads WHERE space=${input.memorySpaceId} AND request_id=${row.request_id}`,
      );
    }
    const retention = yield* readHubRetentionTx(input.memorySpaceId);
    const handles = (yield* handlesFor(input.memorySpaceId)).filter((h) => h.expiresAt > input.now);
    const keep = [
      ...new Set([
        ...(retention.checkpointId ? [snapshotId(retention.checkpointId)] : []),
        ...handles.map((h) => snapshotId(h.checkpointId)),
      ]),
    ];
    const remaining = Math.max(0, limit - Math.min(rows.length, limit));
    const pages = yield* stored(
      "hub-transient-snapshots",
      sql<{
        pending_key: string;
        bytes: number;
      }>`SELECT pending_key,length(CAST(metadata_json AS BLOB)) AS bytes FROM memory_inbox_pending WHERE space=${input.memorySpaceId} AND reason='hub_snapshot' AND checkpoint_id NOT IN (SELECT value FROM json_each(${yield* stringArrayCodec.encode(keep)})) ORDER BY pending_key LIMIT ${remaining + 1}`,
    );
    let released = 0;
    for (const page of pages.slice(0, remaining)) {
      yield* stored(
        "hub-transient-snapshot-delete",
        sql`DELETE FROM memory_inbox_pending WHERE space=${input.memorySpaceId} AND pending_key=${page.pending_key}`,
      );
      released += page.bytes;
    }
    yield* stored(
      "hub-transient-pin-release",
      sql`UPDATE memory_hub_retention SET handles_json=${yield* handleCodec.encode(handles)},published_pinned_bytes=max(0,published_pinned_bytes-${released}) WHERE space=${input.memorySpaceId}`,
    );
    const admins = yield* compactTerminalAdmins(
      input.now,
      Math.max(0, remaining - Math.min(pages.length, remaining)),
    );
    return {
      removedRows:
        Math.min(rows.length, limit) + Math.min(pages.length, remaining) + admins.removedRows,
      cleanupPending: rows.length > limit || pages.length > remaining || admins.cleanupPending,
    };
  });
  const requestHubSourceReadTx: MemoryStoreShape["requestHubSourceReadTx"] = Effect.fn(
    "MemoryStore.requestHubSourceReadTx",
  )(function* (authority, input) {
    const { member, now } = yield* authorizeSource(authority, input.memorySpaceId);
    const encoded = yield* sourceInputCodec.encode(input);
    const requestDigest = hashText(encoded);
    const old = yield* readRelay(input.memorySpaceId, input.requestId);
    if (old) {
      if (
        old.request_digest !== requestDigest ||
        old.requester !== member.environmentId ||
        old.credential_version !== member.credentialVersion
      )
        return yield* new M.MemoryHubError({ code: "operation_id_reused" });
      if (old.deadline <= now || old.state === "expired")
        return yield* new M.MemoryHubError({ code: "source_unavailable" });
      const request = yield* relayRequest(input.memorySpaceId, old);
      if (!request) {
        yield* settleDenied(input.memorySpaceId, old, 0);
        return yield* new M.MemoryHubError({ code: "source_unavailable" });
      }
      return { request };
    }
    const owner = yield* readHubMember(input.memorySpaceId, input.sourceThread.environmentId);
    if (!owner || owner.status !== "active")
      return yield* new M.MemoryHubError({ code: "source_unavailable" });
    const request: M.MemorySourceReadRequest = {
      ...input,
      requesterEnvironmentId: member.environmentId,
      expiresAtHubTime: M.MemoryUtcTimestamp.make(
        DateTime.formatIso(DateTime.makeUnsafe(now + M.MEMORY_SOURCE_READ_TIMEOUT_MS)),
      ),
    };
    // protocolVersion belongs to transport input, not the persisted owner locator.
    const locator: M.MemorySourceReadRequest = {
      requestId: request.requestId,
      memorySpaceId: request.memorySpaceId,
      memoryId: request.memoryId,
      sourceThread: request.sourceThread,
      sourceWatermark: request.sourceWatermark,
      messageIds: request.messageIds,
      limit: request.limit,
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      authorizedScopes: request.authorizedScopes,
      requesterEnvironmentId: request.requesterEnvironmentId,
      stamp: { requesterCredentialVersion: member.credentialVersion, locatorDigest: requestDigest },
      expiresAtHubTime: request.expiresAtHubTime,
    };
    if (!(yield* relayEligible(input.memorySpaceId, locator)))
      return yield* new M.MemoryHubError({ code: "source_invalidated" });
    yield* purgeHubTransientTx({
      memorySpaceId: input.memorySpaceId,
      now,
      limit: M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS,
    });
    const counts = yield* stored(
      "relay-count",
      sql<{
        total: number;
        member: number;
      }>`SELECT count(*) AS total,sum(CASE WHEN requester=${member.environmentId} THEN 1 ELSE 0 END) AS member FROM memory_hub_source_reads WHERE space=${input.memorySpaceId}`,
    );
    if (
      counts[0]!.total >= M.MEMORY_SOURCE_READ_MAX_PER_HUB ||
      (counts[0]!.member ?? 0) >= M.MEMORY_SOURCE_READ_MAX_PER_ENVIRONMENT
    )
      return yield* new MemoryCapacityError({
        dimension:
          counts[0]!.total >= M.MEMORY_SOURCE_READ_MAX_PER_HUB ? "relay_hub" : "relay_environment",
        limit:
          counts[0]!.total >= M.MEMORY_SOURCE_READ_MAX_PER_HUB
            ? M.MEMORY_SOURCE_READ_MAX_PER_HUB
            : M.MEMORY_SOURCE_READ_MAX_PER_ENVIRONMENT,
      });
    yield* stored(
      "relay-request",
      sql`INSERT INTO memory_hub_source_reads(space,request_id,memory_id,requester,owner,credential_version,request_digest,locator_json,state,deadline) VALUES (${input.memorySpaceId},${input.requestId},${input.memoryId},${member.environmentId},${owner.environmentId},${member.credentialVersion},${requestDigest},${yield* sourceRequestCodec.encode(locator)},'pending',${now + M.MEMORY_SOURCE_READ_TIMEOUT_MS})`,
    );
    return { request: locator };
  });
  const collectHubSourceReadsTx: MemoryStoreShape["collectHubSourceReadsTx"] = Effect.fn(
    "MemoryStore.collectHubSourceReadsTx",
  )(function* (authority, input) {
    const { member, now } = yield* authorizeSource(authority, input.memorySpaceId);
    yield* purgeHubTransientTx({
      memorySpaceId: input.memorySpaceId,
      now,
      limit: M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS,
    });
    const rows = yield* stored(
      "relay-collect",
      sql<RelayRow>`SELECT request_id,memory_id,requester,owner,credential_version,request_digest,locator_json,state,deadline,response_digest,payload_ref FROM memory_hub_source_reads WHERE space=${input.memorySpaceId} AND owner=${member.environmentId} AND state='pending' AND deadline>${now} ORDER BY deadline,request_id LIMIT ${Math.max(1, Math.min(input.limit, 32))}`,
    );
    const requests: M.MemorySourceReadRequest[] = [];
    for (const row of rows) {
      const requester = yield* readHubMember(
        input.memorySpaceId,
        M.EnvironmentId.make(row.requester),
      );
      const request = yield* relayRequest(input.memorySpaceId, row);
      if (!request) {
        yield* settleDenied(input.memorySpaceId, row, 0);
        continue;
      }
      if (
        !requester ||
        requester.status !== "active" ||
        requester.credentialVersion !== row.credential_version ||
        !(yield* relayEligible(input.memorySpaceId, request))
      ) {
        yield* eraseRelayPayload(input.memorySpaceId, row);
        continue;
      }
      const next = [...requests, request];
      const encoded = yield* Effect.forEach(next, (value) => sourceRequestCodec.encode(value));
      const bytes = new TextEncoder().encode(`{"requests":[${encoded.join(",")}]}`).length;
      if (bytes > M.MEMORY_SOURCE_READ_OUTCOME_MAX_BYTES) break;
      requests.push(request);
    }
    return yield* sourceCollectCodec.decode(yield* sourceCollectCodec.encode({ requests }), strict);
  });
  const respondHubSourceReadTx: MemoryStoreShape["respondHubSourceReadTx"] = Effect.fn(
    "MemoryStore.respondHubSourceReadTx",
  )(function* (authority, input) {
    const { member, now } = yield* authorizeSource(authority, input.memorySpaceId);
    if (input.kind === "revoke") {
      const requester = yield* readHubMember(input.memorySpaceId, input.requesterEnvironmentId);
      if (!requester) {
        // An absent identity has no authority. Reclamation only runs after saving
        // this space high-water; future credentials exceed every retired version.
        // No pair fence is needed: old relays fail membership/version checks and
        // the owner's committed removal still denies reads after reenrollment.
        const versions = yield* stored(
          "relay-absent-member-fence",
          sql<{ value: number }>`SELECT value FROM memory_quota_counters
            WHERE space=${input.memorySpaceId} AND dimension='hub_member_version' AND scope_key=''`,
        );
        const highWater = versions[0]?.value;
        if (highWater === undefined || !Number.isSafeInteger(highWater) || highWater <= 0)
          return yield* new M.MemoryHubError({ code: "identity_mismatch" });
        return {
          kind: "revoke" as const,
          accepted: true as const,
          ack: {
            memorySpaceId: input.memorySpaceId,
            ownerEnvironmentId: member.environmentId,
            requesterEnvironmentId: input.requesterEnvironmentId,
            removalEpoch: input.ownerPolicyEpoch,
            revokedThroughEpoch: input.ownerPolicyEpoch,
          },
        };
      }
      const fences = yield* readPairFences(input.memorySpaceId, member.environmentId);
      const previous = fences.find(
        (f) => f.requesterEnvironmentId === input.requesterEnvironmentId,
      );
      const epoch = Math.max(previous?.revokedThroughEpoch ?? -1, input.ownerPolicyEpoch);
      if (!previous || epoch > previous.revokedThroughEpoch) {
        const next = [
          ...fences.filter((f) => f.requesterEnvironmentId !== input.requesterEnvironmentId),
          {
            memorySpaceId: input.memorySpaceId,
            ownerEnvironmentId: member.environmentId,
            requesterEnvironmentId: input.requesterEnvironmentId,
            revokedThroughEpoch: epoch,
          },
        ];
        const json = yield* pairFencesCodec.encode(next);
        yield* stored(
          "relay-pair-revoke",
          sql`INSERT INTO memory_import_keys(space,key_kind,key,memory_id,record_json) VALUES (${input.memorySpaceId},'hub_source_fences',${member.environmentId},${input.memorySpaceId},${json}) ON CONFLICT(space,key_kind,key) DO UPDATE SET record_json=excluded.record_json`,
        );
        const rows = yield* stored(
          "relay-pair-settle",
          sql<RelayRow>`SELECT request_id,memory_id,requester,owner,credential_version,request_digest,locator_json,state,deadline,response_digest,payload_ref FROM memory_hub_source_reads WHERE space=${input.memorySpaceId} AND owner=${member.environmentId} AND requester=${input.requesterEnvironmentId} AND state IN ('pending','completed') ORDER BY request_id LIMIT ${M.MEMORY_SOURCE_READ_MAX_PER_HUB + 1}`,
        );
        if (rows.length > M.MEMORY_SOURCE_READ_MAX_PER_HUB)
          return yield* new M.MemoryHubError({ code: "capacity_exceeded" });
        for (const row of rows) yield* settleDenied(input.memorySpaceId, row, epoch);
      }
      return {
        kind: "revoke" as const,
        accepted: true as const,
        ack: {
          memorySpaceId: input.memorySpaceId,
          ownerEnvironmentId: member.environmentId,
          requesterEnvironmentId: input.requesterEnvironmentId,
          removalEpoch: input.ownerPolicyEpoch,
          revokedThroughEpoch: epoch,
        },
      };
    }
    const row = yield* readRelay(input.memorySpaceId, input.requestId);
    if (!row || row.owner !== member.environmentId)
      return yield* new M.MemoryHubError({ code: "identity_mismatch" });
    const requester = yield* readHubMember(
      input.memorySpaceId,
      M.EnvironmentId.make(row.requester),
    );
    if (
      row.deadline <= now ||
      row.state === "expired" ||
      !requester ||
      requester.status !== "active" ||
      requester.credentialVersion !== row.credential_version
    ) {
      yield* eraseRelayPayload(input.memorySpaceId, row);
      return { kind: "normal" as const, accepted: false };
    }
    const request = yield* relayRequest(input.memorySpaceId, row);
    if (!request) {
      yield* settleDenied(input.memorySpaceId, row, 0);
      return { kind: "normal" as const, accepted: false };
    }
    const previous = row.response_digest
      ? yield* settlementCodec
          .decode(row.response_digest, strict)
          .pipe(Effect.orElseSucceed(() => null))
      : null;
    const responseDigest = hashText(yield* sourceRespondCodec.encode(input));
    if (previous?.denied && previous.responseDigest === responseDigest)
      return { kind: "normal" as const, accepted: true };
    if (
      previous?.denied ||
      (input.outcome.kind === "available" && input.ownerPolicyEpoch === 0) ||
      input.ownerPolicyEpoch <= (yield* pairFence(input.memorySpaceId, row))
    ) {
      yield* settleDenied(
        input.memorySpaceId,
        row,
        Math.max(input.ownerPolicyEpoch, previous?.ownerPolicyEpoch ?? 0),
      );
      return { kind: "normal" as const, accepted: false };
    }
    if (!(yield* relayEligible(input.memorySpaceId, request))) {
      yield* eraseRelayPayload(input.memorySpaceId, row);
      return { kind: "normal" as const, accepted: false };
    }
    if (row.response_digest) {
      if (previous?.responseDigest !== responseDigest)
        return yield* new M.MemoryHubError({ code: "operation_id_reused" });
      return { kind: "normal" as const, accepted: row.state === "completed" };
    }
    if (
      input.outcome.kind === "available" &&
      ((yield* sourceThreadCodec.encode(input.outcome.page.sourceThread)) !==
        (yield* sourceThreadCodec.encode(request.sourceThread)) ||
        (yield* sourceWatermarkCodec.encode(input.outcome.page.watermark)) !==
          (yield* sourceWatermarkCodec.encode(request.sourceWatermark)) ||
        input.outcome.page.messages.length > request.limit ||
        input.outcome.page.messages.some((m) => !request.messageIds.includes(m.messageId)))
    )
      return yield* new M.MemoryHubError({ code: "source_invalidated" });
    const outcome: M.MemorySourceReadOutcome =
      scanMemoryValue(input.outcome).kind === "allowed"
        ? input.outcome
        : { kind: "unavailable", code: "secret_detected" };
    const json = yield* sourceOutcomeCodec.encode(outcome);
    const payloadRef = `relay:${input.requestId}`;
    // A transient body has no revision, event, report, checkpoint or FTS reference.
    if (outcome.kind !== "denied")
      yield* stored(
        "relay-response-payload",
        sql`INSERT INTO memory_payloads(space,payload_ref,memory_id,body_json,dependencies_json,purge_eligible_after) VALUES (${input.memorySpaceId},${payloadRef},${request.memoryId},${json},'[]',${row.deadline})`,
      );
    yield* stored(
      "relay-response",
      sql`UPDATE memory_hub_source_reads SET state='completed',response_digest=${yield* settlementCodec.encode({ responseDigest, ownerPolicyEpoch: input.ownerPolicyEpoch, denied: outcome.kind === "denied" })},payload_ref=${outcome.kind === "denied" ? null : payloadRef} WHERE space=${input.memorySpaceId} AND request_id=${input.requestId}`,
    );
    return { kind: "normal" as const, accepted: true };
  });
  const resultHubSourceReadTx: MemoryStoreShape["resultHubSourceReadTx"] = Effect.fn(
    "MemoryStore.resultHubSourceReadTx",
  )(function* (authority, input) {
    const { member, now } = yield* authorizeSource(authority, input.memorySpaceId);
    const row = yield* readRelay(input.memorySpaceId, input.requestId);
    if (!row) return { state: "expired", code: "source_unavailable" };
    if (
      row.requester !== member.environmentId ||
      row.credential_version !== member.credentialVersion
    )
      return yield* new M.MemoryHubError({ code: "identity_mismatch" });
    const owner = yield* readHubMember(input.memorySpaceId, M.EnvironmentId.make(row.owner));
    if (row.deadline <= now || row.state === "expired" || !owner || owner.status !== "active") {
      yield* eraseRelayPayload(input.memorySpaceId, row);
      return { state: "expired", code: "source_unavailable" };
    }
    const settlement = row.response_digest
      ? yield* settlementCodec
          .decode(row.response_digest, strict)
          .pipe(Effect.orElseSucceed(() => null))
      : null;
    if (
      settlement?.denied ||
      (settlement && settlement.ownerPolicyEpoch <= (yield* pairFence(input.memorySpaceId, row)))
    ) {
      yield* settleDenied(input.memorySpaceId, row, settlement.ownerPolicyEpoch);
      return {
        state: "completed",
        outcome: { kind: "denied", requiredPermission: "orchestration:read" },
      };
    }
    const request = yield* relayRequest(input.memorySpaceId, row);
    if (!request || (row.state === "completed" && !settlement)) {
      yield* settleDenied(input.memorySpaceId, row, 0);
      return {
        state: "completed",
        outcome: { kind: "denied", requiredPermission: "orchestration:read" },
      };
    }
    if (!(yield* relayEligible(input.memorySpaceId, request))) {
      yield* eraseRelayPayload(input.memorySpaceId, row);
      return { state: "completed", outcome: { kind: "unavailable", code: "source_invalidated" } };
    }
    if (row.state === "pending")
      return { state: "pending", expiresAtHubTime: request.expiresAtHubTime };
    const bodies = yield* stored(
      "relay-result",
      sql<{
        body_json: string;
      }>`SELECT body_json FROM memory_payloads WHERE space=${input.memorySpaceId} AND payload_ref=${row.payload_ref}`,
    );
    if (!bodies[0]) {
      yield* eraseRelayPayload(input.memorySpaceId, row);
      return { state: "expired", code: "source_unavailable" };
    }
    const outcome = yield* sourceOutcomeCodec.decode(bodies[0].body_json, strict);
    yield* eraseRelayPayload(input.memorySpaceId, row);
    return { state: "completed", outcome };
  });
  return {
    purgeHubTransientTx,
    requestHubSourceReadTx,
    collectHubSourceReadsTx,
    respondHubSourceReadTx,
    resultHubSourceReadTx,
  };
};

export type SourceReads = ReturnType<typeof makeSourceReads>;

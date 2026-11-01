import * as M from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { strict } from "./StoreModel.ts";

/** Fixed-width UUID/digest fields; environment strings are admitted once in the SQL dictionary. */
export function encodeCompactReceipt(
  record: M.MemoryCompactReceipt,
  environmentOrdinal: (id: M.EnvironmentId) => number,
): Uint8Array {
  const bytes: number[] = [record.upsertRequestDigest === undefined ? 2 : 3];
  const byte = (value: number) => bytes.push(value);
  const number = (value: number) => {
    let remaining = BigInt(value);
    do {
      const part = Number(remaining & 127n);
      remaining >>= 7n;
      byte(part | (remaining ? 128 : 0));
    } while (remaining);
  };
  const uuid = (value: string | null) => {
    byte(value === null ? 0 : 1);
    if (value !== null)
      for (const pair of value.replaceAll("-", "").match(/../g) ?? []) byte(parseInt(pair, 16));
  };
  const hash = (value: string) => {
    for (const pair of value.match(/../g) ?? []) byte(parseInt(pair, 16));
  };
  byte(["upsert", "forget", "resolve", "revert"].indexOf(record.operationKind));
  byte(["accepted", "conflicted", "deleted", "rejected"].indexOf(record.receipt.outcome));
  uuid(record.receipt.operationId);
  uuid(record.receipt.memoryId);
  hash(record.receipt.operationDigest);
  number(record.receipt.hubSequence!);
  number(environmentOrdinal(record.originEnvironmentId));
  uuid(record.revisionId);
  uuid(record.resolutionId);
  uuid(record.attemptId);
  number(record.fencingToken ?? 0);
  byte(record.revertsResolutionId === null ? 0 : 1);
  byte(record.reportGuard === null ? 0 : 1);
  if (record.reportGuard) {
    hash(record.reportGuard.reportId);
    number(environmentOrdinal(record.reportGuard.resolvingEnvironmentId));
    byte(record.reportGuard.outcome === "resolved" ? 0 : 1);
  }
  byte(
    record.receipt.failureCode === undefined
      ? 0
      : M.MemoryFailureCode.literals.indexOf(record.receipt.failureCode) + 1,
  );
  byte(record.receipt.capacity === undefined ? 0 : 1);
  if (record.receipt.capacity) {
    byte(M.MemoryCapacityDimension.literals.indexOf(record.receipt.capacity.dimension));
    number(record.receipt.capacity.current);
    number(record.receipt.capacity.limit);
    number(record.receipt.capacity.reclaimable);
  }
  byte(record.receipt.resolutionApproval === undefined ? 0 : 1);
  if (record.receipt.resolutionApproval) {
    const appliedAt = Date.parse(record.receipt.resolutionApproval.appliedAtUtc);
    byte(appliedAt < 0 ? 1 : 0);
    number(Math.abs(appliedAt));
  }
  byte(record.receipt.forgetExpansion === undefined ? 0 : 1);
  if (record.receipt.forgetExpansion) {
    hash(record.receipt.forgetExpansion.requestDigest);
    uuid(record.receipt.forgetExpansion.operationId);
    hash(record.receipt.forgetExpansion.operationDigest);
    byte(["accepted", "pending", "rejected"].indexOf(record.receipt.forgetExpansion.status));
  }
  byte(record.receipt.forgetRetryOf === undefined ? 0 : 1);
  if (record.receipt.forgetRetryOf) {
    uuid(record.receipt.forgetRetryOf.operationId);
    hash(record.receipt.forgetRetryOf.operationDigest);
  }
  if (record.upsertRequestDigest !== undefined) hash(record.upsertRequestDigest);
  return Uint8Array.from(bytes);
}

/** Decode stored v1/v2/v3 rows without granting old resolve rows authoritative approval. */
export function decodeCompactReceipt(
  bytes: Uint8Array,
  space: M.MemorySpaceId,
  environmentAt: (ordinal: number) => M.EnvironmentId,
): M.MemoryCompactReceipt {
  let offset = 0;
  const byte = () => {
    if (offset >= bytes.length) throw new RangeError("Truncated compact receipt");
    return bytes[offset++]!;
  };
  const version = byte();
  if (version !== 1 && version !== 2 && version !== 3)
    throw new RangeError("Unsupported compact receipt");
  const number = () => {
    let value = 0n;
    let shift = 0n;
    for (let i = 0; i < 8; i++) {
      const part = byte();
      value |= BigInt(part & 127) << shift;
      if (!(part & 128)) {
        if (value > BigInt(Number.MAX_SAFE_INTEGER))
          throw new RangeError("Invalid compact integer");
        return Number(value);
      }
      shift += 7n;
    }
    throw new RangeError("Invalid compact integer");
  };
  const hash = () =>
    Array.from({ length: 32 }, () => byte().toString(16).padStart(2, "0")).join("");
  const uuid = () => {
    const present = byte();
    if (present === 0) return null;
    if (present !== 1) throw new RangeError("Invalid compact marker");
    const hex = Array.from({ length: 16 }, () => byte().toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  const operationKind = ["upsert", "forget", "resolve", "revert"][byte()];
  const outcome = ["accepted", "conflicted", "deleted", "rejected"][byte()];
  const operationId = uuid(),
    memoryId = uuid(),
    operationDigest = hash();
  const hubSequence = number(),
    originEnvironmentId = environmentAt(number());
  const revisionId = uuid(),
    resolutionId = uuid(),
    attemptId = uuid(),
    fencingToken = number() || null;
  const revertsResolutionId = byte() ? resolutionId : null;
  const reportGuard = byte()
    ? {
        reportId: hash(),
        resolvingEnvironmentId: environmentAt(number()),
        resolutionId,
        outcome: byte() ? "reverted" : "resolved",
      }
    : null;
  const failure = byte();
  const capacity = byte()
    ? {
        code: "capacity_exceeded",
        dimension: M.MemoryCapacityDimension.literals[byte()],
        current: number(),
        limit: number(),
        reclaimable: number(),
      }
    : undefined;
  const appliedAt = version >= 2 && byte() ? (byte() ? -1 : 1) * number() : undefined;
  const forgetExpansion =
    version >= 2 && byte()
      ? {
          requestDigest: hash(),
          operationId: uuid(),
          operationDigest: hash(),
          status: ["accepted", "pending", "rejected"][byte()],
        }
      : undefined;
  const forgetRetryOf =
    version >= 2 && byte() ? { operationId: uuid(), operationDigest: hash() } : undefined;
  const upsertRequestDigest = version === 3 ? hash() : undefined;
  if (offset !== bytes.length) throw new RangeError("Trailing compact receipt bytes");
  // Legacy storage accepts approval-free resolves. It must not pass the current wire decoder.
  const storedSchema =
    version === 1
      ? Schema.Struct({
          memorySpaceId: M.MemorySpaceId,
          originEnvironmentId: M.EnvironmentId,
          operationKind: Schema.Literals(["upsert", "forget", "resolve", "revert"]),
          receipt: M.MemoryHubReceipt,
          revisionId: Schema.NullOr(M.MemoryRevisionId),
          resolutionId: Schema.NullOr(M.MemoryResolutionId),
          revertsResolutionId: Schema.NullOr(M.MemoryResolutionId),
          attemptId: Schema.NullOr(M.MemoryOperationId),
          fencingToken: Schema.NullOr(Schema.Int),
          reportGuard: Schema.NullOr(M.MemoryCheckpointReportGuard),
        })
      : M.MemoryCompactReceipt;
  return Schema.decodeUnknownSync(storedSchema)(
    {
      memorySpaceId: space,
      originEnvironmentId,
      operationKind,
      ...(upsertRequestDigest !== undefined ? { upsertRequestDigest } : {}),
      receipt: {
        operationId,
        memoryId,
        operationDigest,
        hubSequence,
        outcome,
        ...(failure ? { failureCode: M.MemoryFailureCode.literals[failure - 1] } : {}),
        ...(capacity ? { capacity } : {}),
        ...(appliedAt !== undefined
          ? {
              resolutionApproval: {
                resolutionId,
                appliedAtUtc: DateTime.formatIso(DateTime.makeUnsafe(appliedAt)),
                revertDeadlineUtc: DateTime.formatIso(
                  DateTime.makeUnsafe(appliedAt + M.MEMORY_REVERT_WINDOW_MS),
                ),
              },
            }
          : {}),
        ...(forgetExpansion ? { forgetExpansion } : {}),
        ...(forgetRetryOf ? { forgetRetryOf } : {}),
      },
      revisionId,
      resolutionId,
      revertsResolutionId,
      attemptId,
      fencingToken,
      reportGuard,
    },
    strict,
  );
}

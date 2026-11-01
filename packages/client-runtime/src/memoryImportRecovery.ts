import { EnvironmentId, MemoryOperationId, MemorySpaceId } from "@goat/contracts";
import * as Schema from "effect/Schema";

export const MEMORY_IMPORT_RECOVERY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const timestamp = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
export const MemoryImportRecoveryHandle = Schema.Struct({
  environmentId: EnvironmentId,
  memorySpaceId: MemorySpaceId,
  operationId: MemoryOperationId,
  savedAt: timestamp,
  expiresAt: timestamp,
})
  .check(
    Schema.makeFilter(
      (v) =>
        Number.isSafeInteger(v.expiresAt) &&
        v.expiresAt - v.savedAt === MEMORY_IMPORT_RECOVERY_TTL_MS,
    ),
  )
  .pipe(Schema.brand("MemoryImportRecoveryHandle"));
export type MemoryImportRecoveryHandle = typeof MemoryImportRecoveryHandle.Type;
export type MemoryImportDestination = Pick<
  MemoryImportRecoveryHandle,
  "environmentId" | "memorySpaceId"
>;

export interface MemoryImportRecoveryStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

export function memoryImportRecoveryKey(destination: MemoryImportDestination) {
  return `goat:memory-import:v1:${JSON.stringify([destination.environmentId, destination.memorySpaceId])}`;
}

const RecoveryEnvelope = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(1), handle: MemoryImportRecoveryHandle }),
);

const decodeEnvelope = Schema.decodeUnknownSync(RecoveryEnvelope);
const encodeEnvelope = Schema.encodeSync(RecoveryEnvelope);
const decodeHandle = Schema.decodeSync(MemoryImportRecoveryHandle);

/** Reject extra fields rather than quietly accepting private data from another codec. */
export function decodeMemoryImportRecovery(raw: string, now: number) {
  try {
    const { handle } = decodeEnvelope(raw, { onExcessProperty: "error" });
    return Number.isSafeInteger(now) && now >= handle.savedAt && now < handle.expiresAt
      ? handle
      : null;
  } catch {
    return null;
  }
}

export function encodeMemoryImportRecovery(handle: MemoryImportRecoveryHandle) {
  // Explicit projection is deliberate: even a structurally wider caller cannot persist a body.
  const { environmentId, memorySpaceId, operationId, savedAt, expiresAt } = handle;
  const checked = decodeHandle({ environmentId, memorySpaceId, operationId, savedAt, expiresAt });
  return encodeEnvelope({ version: 1, handle: checked });
}

/** One instance per storage adapter; serializes overlapping calls without scanning storage. */
export function createMemoryImportRecoveryStore(
  storage: MemoryImportRecoveryStorage,
  now: () => number,
) {
  let tail = Promise.resolve();
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const result = tail.then(run);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  async function read(destination: MemoryImportDestination) {
    const key = memoryImportRecoveryKey(destination);
    const raw = await storage.getItem(key);
    if (raw === null) return null;
    const handle = decodeMemoryImportRecovery(raw, now());
    if (
      handle === null ||
      handle.environmentId !== destination.environmentId ||
      handle.memorySpaceId !== destination.memorySpaceId
    ) {
      await storage.removeItem(key);
      return null;
    }
    return handle;
  }
  return {
    load: (destination: MemoryImportDestination) => serial(() => read(destination)),
    save: (destination: MemoryImportDestination, operationId: MemoryOperationId) =>
      serial(async () => {
        const existing = await read(destination);
        if (existing !== null) throw new Error("Check the previous import result first");
        const savedAt = now();
        const handle = decodeHandle({
          ...destination,
          operationId,
          savedAt,
          expiresAt: savedAt + MEMORY_IMPORT_RECOVERY_TTL_MS,
        });
        await storage.setItem(
          memoryImportRecoveryKey(destination),
          encodeMemoryImportRecovery(handle),
        );
        return handle;
      }),
    /** Pass the known destination on removal/rebind/revoke; no key enumeration needed. */
    clear: (destination: MemoryImportDestination, operationId?: MemoryOperationId) =>
      serial(async () => {
        if (operationId !== undefined) {
          const existing = await read(destination);
          if (existing === null || existing.operationId !== operationId) return;
        }
        await storage.removeItem(memoryImportRecoveryKey(destination));
      }),
  };
}
export type MemoryImportRecoveryStore = ReturnType<typeof createMemoryImportRecoveryStore>;

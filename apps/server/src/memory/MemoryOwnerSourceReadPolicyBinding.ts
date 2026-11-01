import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Settings from "../serverSettings.ts";
import * as Owner from "./MemoryOwnerSourceReader.ts";
import * as Service from "./MemoryService.ts";

/** Adapt the application settings owner without exposing persistence errors to relay. */
export const layer = Layer.effect(
  Owner.MemoryOwnerSourceReadPolicyPort,
  Effect.gen(function* () {
    const policy = yield* Settings.MemoryOwnerSourceReadCommittedPolicy;
    return Owner.MemoryOwnerSourceReadPolicyPort.of({
      read: policy.read,
      changes: policy.changes,
      recordRevokeAck: (ack) =>
        policy.recordRevokeAck(ack).pipe(
          Effect.mapError(
            (error) =>
              new Service.MemoryAccessError({
                code: error._tag === "ServerSettingsError" ? "storage_failed" : error.code,
              }),
          ),
        ),
    });
  }),
);

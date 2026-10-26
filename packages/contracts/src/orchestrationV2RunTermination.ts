import * as Schema from "effect/Schema";

export const OrchestrationV2RunTerminationCause = Schema.Struct({
  kind: Schema.Literals([
    "person_stop",
    "agent_stop",
    "server_restart",
    "server_shutdown",
    "provider_error",
    "quota",
    "provider_process_exit",
    "queued_cancelled",
    "queued_replaced",
    "delegated_wake_disposed",
    "thread_archive",
    "thread_delete",
    "validation_error",
    "preparation_failed",
    "unknown",
  ]),
});
export type OrchestrationV2RunTerminationCause = typeof OrchestrationV2RunTerminationCause.Type;

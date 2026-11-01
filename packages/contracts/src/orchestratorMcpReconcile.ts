import * as Schema from "effect/Schema";

import { IsoDateTime } from "./baseSchemas.ts";

/** Fields that let a caller reconcile a keyed write whose result was lost. */
export const OrchestratorMcpReconcileFields = {
  /**
   * What goat_thread_organize changes beyond archive, settle and snooze. Missing on older
   * servers, which means unknown, not false.
   */
  thread: {
    /** When the thread was last snoozed, kept after activity wakes it early. */
    snoozedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
    pinned: Schema.optional(Schema.Boolean),
    /** Its latest run finished after the last visit. */
    unread: Schema.optional(Schema.Boolean),
  },
  /** How goat_schedule_update tells whether its secretRef was saved. */
  scheduledTask: {
    webhookSignatureSecretRef: Schema.optional(Schema.String).annotate({
      description:
        "The secretRef the signing secret was saved from. A ref is used once, so an update that passed it saved its secret exactly when this shows it.",
    }),
  },
};

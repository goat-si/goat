import { type ScheduledTask, SecretRef } from "@goat/contracts";

import type { WebhookOrigin } from "./ScheduledTaskService.ts";

export const WEBHOOK_ROUTE_PREFIX = "/api/hooks";

function webhookPath(taskId: string, token: string): string {
  return `${WEBHOOK_ROUTE_PREFIX}/${encodeURIComponent(taskId)}/${token}`;
}

/** A stored task row's webhook as clients see it; the secret itself never leaves the row. */
export function webhookEndpoint(
  row: {
    readonly task_id: string;
    readonly webhook_token: string | null;
    readonly webhook_secret: string | null;
    readonly webhook_secret_ref: string | null;
  },
  origin: WebhookOrigin | null,
): ScheduledTask["webhook"] {
  if (row.webhook_token === null) return undefined;
  const base = origin?.relayHookBaseUrl ?? null;
  const reason = base === null ? origin?.unavailableReason : undefined;
  return {
    path: webhookPath(row.task_id, row.webhook_token),
    url: base === null ? null : `${base}/${encodeURIComponent(row.task_id)}/${row.webhook_token}`,
    ...(reason === undefined ? {} : { urlUnavailableReason: reason }),
    hasSecret: row.webhook_secret !== null,
    ...(row.webhook_secret === null || row.webhook_secret_ref === null
      ? {}
      : { secretRef: SecretRef.make(row.webhook_secret_ref) }),
  };
}

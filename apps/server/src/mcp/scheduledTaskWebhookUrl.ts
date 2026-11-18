import type {
  OrchestratorMcpScheduledTask,
  ScheduledTask,
  ScheduledTaskWebhookUrlUnavailableReason,
} from "@goat/contracts";
import { isGoatConnectEnabled } from "@goat/shared/goatConnect";

/**
 * What an agent tells the user when a webhook task has no public URL. A URL,
 * when present, shows only that the tunnel is configured, not that it runs.
 */
const WEBHOOK_URL_UNAVAILABLE: Record<ScheduledTaskWebhookUrlUnavailableReason, string> = {
  relay_not_linked:
    "This environment is not linked to GOAT Connect. Ask the user to sign in to GOAT Connect and turn on remote access for it.",
  managed_tunnel_not_configured:
    "This environment is linked to GOAT Connect but has no managed tunnel. Ask the user to turn on remote access for it in Settings → Connections.",
  managed_tunnel_unrecognized:
    "This environment's managed tunnel is not one GOAT Connect can route webhooks to. Ask the user to turn remote access off and on again in Settings → Connections.",
};

/**
 * The server cannot tell which of its addresses a sender can reach, so only a
 * client, which knows the address it uses, offers a direct URL.
 */
const WEBHOOK_DIRECT_URL_HINT =
  " A sender that reaches this environment directly (this computer, the local network, or Tailscale) can use the address shown for the task in Settings → Scheduled Tasks.";

/** The link state could not be read, so the cause is unknown. */
const WEBHOOK_URL_UNKNOWN =
  "This environment could not read its GOAT Connect state. Ask the user to check remote access in Settings → Connections.";

/** Public webhook URLs come from the hosted tunnel, which is off until GOAT Connect ships. */
const WEBHOOK_URL_CONNECT_OFF =
  "Public webhook URLs need GOAT Connect, which is coming soon, so this task has no public URL yet.";

/** The URL starts runs, so a caller that may not start one does not see it. */
const WEBHOOK_URL_WITHHELD =
  "The URL is withheld because this caller may not start this task's runs: that needs write access, an active turn for a thread caller, and modes at least as broad as the task's. The user can copy it from Settings → Scheduled Tasks.";

/** The webhook fields of an agent's task summary: the URL, or why it is absent. */
export function webhookUrlFields(
  webhook: ScheduledTask["webhook"],
  mayRun: boolean,
): Pick<OrchestratorMcpScheduledTask, "webhookUrl" | "webhookUrlUnavailableReason"> {
  if (webhook === undefined) return {};
  if (webhook.url !== null) {
    return mayRun
      ? { webhookUrl: webhook.url }
      : { webhookUrlUnavailableReason: WEBHOOK_URL_WITHHELD };
  }
  const reason = webhook.urlUnavailableReason;
  const cause = !isGoatConnectEnabled()
    ? WEBHOOK_URL_CONNECT_OFF
    : reason === undefined
      ? WEBHOOK_URL_UNKNOWN
      : WEBHOOK_URL_UNAVAILABLE[reason];
  return {
    webhookUrlUnavailableReason: cause + WEBHOOK_DIRECT_URL_HINT,
  };
}

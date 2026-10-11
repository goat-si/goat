import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";

import { useGlobalAgentStore } from "~/globalAgentStore";
import {
  resolveThreadDetailRef,
  useAllEnvironmentShellsBootstrapped,
  useThreadShell,
  useThreadVisibleTurnItems,
} from "~/state/entities";

import { GoatBotChatView } from "./GoatBotChatView";
import { resolveGoatBotAvailability } from "./goatBotAvailability";
import { useGoatBotEnvironments, useLegacyGlobalAgentRoute } from "./goatBotHooks";
import { goatBotItemReaders } from "./goatBotReaders";
import { buildGoatBotTimeline } from "./goatBotRows";

const NO_PENDING = [] as const;
const noop = () => {};

/**
 * The GOAT Bot thread. It always renders as the bot, whatever the server or
 * connection state, so the coding composer never appears on it. Sending stays
 * off until the server confirms the bot on this connection.
 */
export function GoatBotThreadView({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const shell = useThreadShell(threadRef);
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const visibleTurnItems = useThreadVisibleTurnItems(
    resolveThreadDetailRef(threadRef, { shellExists: shell !== null, waitForShell: true }),
  );
  const rows = useMemo(
    () =>
      buildGoatBotTimeline({
        visibleTurnItems,
        pendingInputs: NO_PENDING,
        readers: goatBotItemReaders,
      }),
    [visibleTurnItems],
  );
  const environments = useGoatBotEnvironments();
  const botRef = useGlobalAgentStore((state) => state.botRef);
  const availability = resolveGoatBotAvailability({
    environments,
    botRef,
    ensure: { state: "idle" },
  });
  const legacyAgentRoute = useLegacyGlobalAgentRoute();
  const removed =
    bootstrapped && (shell === null || shell.archivedAt !== null || shell.deletedAt != null);
  return (
    <GoatBotChatView
      availability={availability}
      canOperate={false}
      rows={removed ? NO_PENDING : rows}
      removed={removed}
      onSend={noop}
      onRetryInput={noop}
      legacyAgentRoute={legacyAgentRoute}
    />
  );
}

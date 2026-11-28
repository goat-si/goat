import type { EnvironmentId, OrchestrationV2Subagent, ThreadId } from "@goat/contracts";
import type { ComposerThreadHosts } from "@goat/client-runtime/composerThreadItems";
import { deriveSubagentElapsedMs } from "@goat/shared/orchestrationTiming";
import * as DateTime from "effect/DateTime";
import { BotIcon } from "~/components/solar";
import { AgentElapsed } from "./AgentElapsed";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadRelationshipIcon, threadRelationshipStatusLabel } from "./ThreadRelationshipIcon";

export type RemoteLineageAgent = OrchestrationV2Subagent & {
  readonly remote: NonNullable<OrchestrationV2Subagent["remote"]>;
};
export type LineageRow =
  | import("@goat/client-runtime/state/thread-relationships").ThreadRelationshipWalkRow
  | { readonly remote: RemoteLineageAgent };
export const finishedLineageStatus = (status: string | null | undefined) =>
  ["completed", "failed", "error", "cancelled", "interrupted", "idle"].includes(status ?? "");

export function RemoteLineageRow({
  agent,
  hosts,
  onOpen,
  anyInstanceBadge,
}: {
  readonly agent: RemoteLineageAgent;
  readonly hosts: ComposerThreadHosts;
  readonly anyInstanceBadge: boolean;
  readonly onOpen: (environmentId: EnvironmentId, threadId: ThreadId) => void;
}) {
  const environmentId = hosts.resolve(agent.remote.host);
  const threadId = agent.remote.threadId;
  const failed = agent.status === "failed";
  const timing = {
    status: agent.status,
    startedAt: agent.startedAt ? DateTime.formatIso(agent.startedAt) : null,
    completedAt: agent.completedAt ? DateTime.formatIso(agent.completedAt) : null,
  };
  const showElapsed = !failed && deriveSubagentElapsedMs(timing, 0) !== null;
  return (
    <li>
      <ThreadDetailsControl
        size="sm"
        variant="ghost"
        part="row"
        disabled={!environmentId || !threadId}
        onClick={() => {
          if (environmentId && threadId) onOpen(environmentId, threadId);
        }}
      >
        <ThreadRelationshipIcon
          anyInstanceBadge={anyInstanceBadge}
          fallbackIcon={BotIcon}
          status={agent.status}
        />
        <span className="min-w-0 flex-1 truncate text-left">
          {agent.title || agent.prompt || "Remote agent"}
        </span>
        <span className="flex max-w-1/2 shrink-0 gap-1">
          <span className="min-w-0 truncate">· {agent.remote.host}</span>
          <span className="shrink-0 tabular-nums">
            {showElapsed ? (
              <AgentElapsed agent={timing} compact />
            ) : (
              threadRelationshipStatusLabel(agent.status)
            )}
          </span>
        </span>
      </ThreadDetailsControl>
    </li>
  );
}

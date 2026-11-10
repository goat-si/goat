import type { EnvironmentId, OrchestrationV2Subagent, ThreadId } from "@goat/contracts";
import type { ComposerThreadHosts } from "@goat/client-runtime/composerThreadItems";
import { BotIcon } from "~/components/solar";
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
}: {
  readonly agent: RemoteLineageAgent;
  readonly hosts: ComposerThreadHosts;
  readonly onOpen: (environmentId: EnvironmentId, threadId: ThreadId) => void;
}) {
  const environmentId = hosts.resolve(agent.remote.host);
  const threadId = agent.remote.threadId;
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
        <ThreadRelationshipIcon fallbackIcon={BotIcon} status={agent.status} />
        <span className="min-w-0 flex-1 truncate text-left">
          {agent.title || agent.prompt || "Remote agent"}
        </span>
        <span className="flex max-w-1/2 shrink-0 gap-1">
          <span className="min-w-0 truncate">· {agent.remote.host}</span>
          <span className="shrink-0">{threadRelationshipStatusLabel(agent.status)}</span>
        </span>
      </ThreadDetailsControl>
    </li>
  );
}

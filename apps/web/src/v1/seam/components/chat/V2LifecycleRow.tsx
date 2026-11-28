// Seam (lane F): replaces v1 apps/web/src/components/chat/V2LifecycleRow.tsx @916b5cc. v1 draws subagent lifecycle rows from environment thread atoms. GOAT 2 children arrive as child.started /
// child.reported lines (useV1Thread); until the lifecycle row is lifted, a notification row keeps v1's own fallback
// (the plain work entry row). HandoffTimelineRun is re-exported from the lifted handoff module, as v1 does.
// Listed in docs/PROVENANCE.md (v1 bridge table).
import type { ReactNode } from "react";
import type { NodeId, OrchestrationV2Notification, ScopedThreadRef, ThreadId } from "@goat/contracts";
import type { TimestampFormat } from "@goat/contracts/settings";

export type { HandoffTimelineRun } from "@goat/client-runtime/handoff";

export function SubagentNotificationLink(props: {
  readonly parentRef: ScopedThreadRef;
  readonly childThreadId: ThreadId;
  readonly taskIds?: ReadonlyArray<NodeId> | undefined;
  readonly outcome: OrchestrationV2Notification["outcome"];
  readonly createdAt: string;
  readonly timestampFormat: TimestampFormat;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly fallback: ReactNode;
}) {
  return props.fallback;
}

import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@goat/contracts";
import { useMemo } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";
import { ThreadWorkspaceBanner } from "./ThreadWorkspaceBanner";
import { useThreadWorkspaceStatusRefresh } from "./useThreadWorkspaceStatusRefresh";

/** The thread screen's workspace banner, kept current while the thread is open (goat#3692). */
export function LiveThreadWorkspaceBanner(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { environmentId, threadId } = props;
  const query = serverEnvironment.threadWorkspaceStatus({ environmentId, input: { threadId } });
  const result = useAtomValue(query);
  const status = result._tag === "Success" ? result.value : undefined;
  const threadRef = useMemo(() => ({ environmentId, threadId }), [environmentId, threadId]);
  useThreadWorkspaceStatusRefresh(
    threadRef,
    status?.state === "cleaned" || status?.state === "missing" || status?.setupIncomplete === true,
    () => appAtomRegistry.refresh(query),
  );
  return <ThreadWorkspaceBanner environmentId={environmentId} threadId={threadId} />;
}

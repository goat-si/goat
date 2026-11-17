import type { EnvironmentId, ThreadId } from "@goat/contracts";

import { ThreadWorkspaceBanner } from "./ThreadWorkspaceBanner";

/** The thread screen's workspace banner. */
export function LiveThreadWorkspaceBanner(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  return <ThreadWorkspaceBanner environmentId={props.environmentId} threadId={props.threadId} />;
}

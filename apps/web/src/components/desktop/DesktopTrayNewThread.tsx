import { useAtomValue } from "@effect/atom-react";
import { useEffect, useEffectEvent } from "react";

import { useStartChatNew } from "../../hooks/useStartChatNew";
import { provideNewThread } from "../../newThreadRequests";
import { allReachableShellsLiveAtom } from "../../state/shell";

/**
 * Answers the desktop tray's New Thread on every page, Settings and Usage included. A request made
 * at launch waits until the reachable environments have reported their projects.
 */
export function DesktopTrayNewThread() {
  const projectsKnown = useAtomValue(allReachableShellsLiveAtom);
  const startChatNew = useStartChatNew();
  const start = useEffectEvent(() => void startChatNew());
  // oxlint-disable-next-line goat/react-effect-budget -- registers with the module-level request mailbox for the host's lifetime.
  useEffect(() => (projectsKnown ? provideNewThread(start) : undefined), [projectsKnown]);
  return null;
}

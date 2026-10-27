import { useEffect, useEffectEvent } from "react";

import { useStartChatNew } from "../../hooks/useStartChatNew";
import { provideNewThread } from "../../newThreadRequests";

/** Answers the desktop tray's New Thread on every page, Settings and Usage included. */
export function DesktopTrayNewThread() {
  const startChatNew = useStartChatNew();
  const start = useEffectEvent(() => void startChatNew());
  // oxlint-disable-next-line goat/react-effect-budget -- registers with the module-level request mailbox for the host's lifetime.
  useEffect(() => provideNewThread(start), []);
  return null;
}

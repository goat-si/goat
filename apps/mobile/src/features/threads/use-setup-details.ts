import { useState } from "react";

export function useSetupDetails(threadId: string) {
  const [state, setState] = useState({ threadId, open: false });
  if (state.threadId !== threadId) setState({ threadId, open: false });
  return {
    isOpen: state.threadId === threadId && state.open,
    open: () => setState({ threadId, open: true }),
    close: () => setState({ threadId, open: false }),
  };
}

import { selectGlobalAgentMode, useGlobalAgentStore } from "~/globalAgentStore";
import { useGoatBotEnabled } from "./useGoatBotSession";

export function useGoatBotPreferred(): boolean {
  const { enabled } = useGoatBotEnabled();
  const mode = useGlobalAgentStore(selectGlobalAgentMode);
  return enabled && mode === "bot";
}

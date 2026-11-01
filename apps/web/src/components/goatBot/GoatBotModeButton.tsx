import { useNavigate } from "@tanstack/react-router";
import { GlobeIcon } from "~/components/solar";

import { GOAT_BOT_PATH } from "~/globalAgentRoute";
import {
  type GlobalAgentMode,
  selectGlobalAgentMode,
  useGlobalAgentStore,
} from "~/globalAgentStore";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { GoatBotAvatar } from "./GoatBotAvatar";
import { useGoatBotEnabled } from "./useGoatBotSession";

/** True when the logo and sidebar should lead to GOAT Bot rather than the global agent thread. */
export function useGoatBotPreferred(): boolean {
  const { enabled } = useGoatBotEnabled();
  const mode = useGlobalAgentStore(selectGlobalAgentMode);
  return enabled && mode === "bot";
}

const COPY = {
  thread: { label: "Thread mode", hint: "Use the global agent as a regular thread" },
  bot: { label: "GOAT Bot", hint: "Switch back to GOAT Bot" },
} as const satisfies Record<GlobalAgentMode, { label: string; hint: string }>;

/**
 * Switches between GOAT Bot's messenger and the global agent's coding thread. The choice is
 * remembered, so the logo and sidebar keep leading to the same place. Renders nothing on a
 * server without GOAT Bot.
 */
export function GoatBotModeButton({ to }: { readonly to: GlobalAgentMode }) {
  const { enabled } = useGoatBotEnabled();
  const setMode = useGlobalAgentStore((state) => state.setMode);
  const navigate = useNavigate();
  if (!enabled) return null;
  const copy = COPY[to];
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            aria-label={copy.hint}
            onClick={() => {
              setMode(to);
              void navigate({ to: to === "bot" ? GOAT_BOT_PATH : "/" });
            }}
          />
        }
      >
        {to === "bot" ? <GoatBotAvatar size="sm" /> : <GlobeIcon />}
        <span className="max-sm:hidden">{copy.label}</span>
      </TooltipTrigger>
      <TooltipPopup side="bottom">{copy.hint}</TooltipPopup>
    </Tooltip>
  );
}

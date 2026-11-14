import { goatBotNewestTaskChips } from "@goat/client-runtime/goatBot";
import type { OrchestrationV2ProjectedTurnItem } from "@goat/contracts";
import { useState } from "react";

import type { MobileTaskChips } from "./mobileBotTaskStatus";

/**
 * The conversation's newest task chips, read again only when the work revision changes. A streamed
 * reply token changes the items but not the revision, so it neither walks them nor hands Home a new map.
 */
export function useMobileTaskChips(
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  revision: string | null,
): MobileTaskChips {
  const [held, setHeld] = useState(() => ({ revision, chips: goatBotNewestTaskChips(items) }));
  if (held.revision === revision) return held.chips;
  const next = { revision, chips: goatBotNewestTaskChips(items) };
  setHeld(next);
  return next.chips;
}

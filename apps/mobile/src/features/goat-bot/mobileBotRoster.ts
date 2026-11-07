import { botRoster, selectBotChildren } from "@goat/client-runtime/goatBot";
import type { BotProfile, BotThreadRow } from "@goat/contracts";

export function mobileBotRoster({
  supportsProfiles,
  supportsTaskThreads,
  bots,
  children,
  now,
  showMore,
  selectedKey,
}: {
  supportsProfiles: boolean;
  supportsTaskThreads: boolean;
  bots: ReadonlyArray<BotProfile> | undefined;
  children: ReadonlyArray<BotThreadRow> | undefined;
  now: number;
  showMore: boolean;
  selectedKey: string | null;
}) {
  return {
    bots: botRoster({ supportsProfiles, bots }),
    children: selectBotChildren({
      rows: supportsTaskThreads ? (children ?? []) : [],
      now,
      showMore,
      selectedKey,
    }),
  };
}

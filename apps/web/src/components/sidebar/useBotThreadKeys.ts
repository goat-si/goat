import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { environmentThreadShells } from "../../state/threads";

const SHOW_BOT_THREADS_KEY = "goat:sidebar:show-bot-threads";
const NO_KEYS: ReadonlySet<string> = new Set();

/** Whether this device lists GOAT Bot's observation threads; off by default. */
export const useShowBotThreads = () => useLocalStorage(SHOW_BOT_THREADS_KEY, false, Schema.Boolean);

/** GOAT Bot's observation threads, and the ones lists leave out: none once they are shown. */
export function useBotThreadKeys() {
  const [shown] = useShowBotThreads();
  const observation = useAtomValue(environmentThreadShells.goatBotObservationThreadKeysAtom);
  return { observation, hidden: shown ? NO_KEYS : observation };
}

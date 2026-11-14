import type { PropsWithChildren } from "react";

import { goatBotAppChannelPort } from "./goatBotAppChannelPort";
import { GoatBotChannelContext } from "./goatBotChannelPort";

/** Gives GOAT Bot its server connection. Mounted once for the app's lifetime, never swapped. */
export function GoatBotChannelProvider({ children }: PropsWithChildren) {
  return (
    <GoatBotChannelContext.Provider value={goatBotAppChannelPort}>
      {children}
    </GoatBotChannelContext.Provider>
  );
}

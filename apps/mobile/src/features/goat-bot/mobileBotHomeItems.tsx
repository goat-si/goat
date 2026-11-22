import type { ReactNode } from "react";
import type { MobileBotHomeItem } from "./MobileBotTaskList";

export const message = (key: string, node: ReactNode): MobileBotHomeItem => ({
  key,
  render: () => node,
});

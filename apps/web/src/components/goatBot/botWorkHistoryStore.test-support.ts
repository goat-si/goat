import type { BotRemoteWork, BotThreadRow, EnvironmentId } from "@goat/contracts";
import { beginHistoryRead, finishHistoryRead } from "./botWorkHistoryStore";

export function rememberHistoryRows(
  environmentId: EnvironmentId,
  rows: readonly BotThreadRow[],
  remoteWork: readonly BotRemoteWork[] = [],
) {
  const token = beginHistoryRead(environmentId, null);
  if (token)
    finishHistoryRead(
      environmentId,
      null,
      token,
      [{ rows, remoteWork, mainMessageCount: 0, history: {} }],
      true,
    );
}

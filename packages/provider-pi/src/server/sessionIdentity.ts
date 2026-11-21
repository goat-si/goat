import type { ProviderDriverKind } from "@goat/contracts";
import { piRecordString } from "./rpc.ts";
import type { PiThreadState } from "./turnState.ts";

export const isLivePiSession = (state: PiThreadState, id: string | null | undefined) =>
  id === state.providerThread.nativeThreadRef?.nativeId ||
  (id != null && state.supersededSessionFiles.has(id));

export function adoptLivePiSession(
  state: PiThreadState,
  data: unknown,
  driver: ProviderDriverKind,
) {
  const sessionFile = piRecordString(data, "sessionFile");
  const previousFile = state.providerThread.nativeThreadRef?.nativeId;
  if (sessionFile === undefined || sessionFile === previousFile) return undefined;
  if (previousFile != null) state.supersededSessionFiles.add(previousFile);
  if (state.supersededSessionFiles.size > 128) {
    const oldest = state.supersededSessionFiles.values().next().value;
    if (oldest !== undefined) state.supersededSessionFiles.delete(oldest);
  }
  state.supersededSessionFiles.delete(sessionFile);
  state.providerThread = {
    ...state.providerThread,
    nativeThreadRef: { driver, nativeId: sessionFile, strength: "strong" },
  };
  return sessionFile;
}

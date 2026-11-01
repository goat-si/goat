import { squashAtomCommandFailure, type AtomCommand } from "@goat/client-runtime/state/runtime";
import { useAtomCommand } from "../state/use-atom-command";
import type { NoteReply } from "./noteState";

export function useNoteCommand<W, A, E>(command: AtomCommand<W, A, E>) {
  const run = useAtomCommand(command, { reportFailure: false });
  return async (input: W): Promise<NoteReply<A>> => {
    const result = await run(input);
    return result._tag === "Success"
      ? { ok: true, value: result.value }
      : { ok: false, error: squashAtomCommandFailure(result) };
  };
}

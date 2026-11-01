import type { NotesStartWorkInput, NotesStartWorkResult } from "@goat/contracts";
import { isAmbiguousLaunch, noteErrorMessage, type NoteReply } from "./noteState";

export type NoteWorkDraft = Omit<NotesStartWorkInput, "requestId">;
interface WorkState {
  requestId: string;
  input: NotesStartWorkInput | null;
  busy: boolean;
  ambiguous: boolean;
  error: string | null;
}

export class NoteWorkSession {
  private state: WorkState;
  private listeners = new Set<() => void>();
  constructor(
    requestId: string,
    private start: (input: NotesStartWorkInput) => Promise<NoteReply<NotesStartWorkResult>>,
  ) {
    this.state = { requestId, input: null, busy: false, ambiguous: false, error: null };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(next: WorkState) {
    this.state = next;
    for (const listener of this.listeners) listener();
  }
  async launch(draft: NoteWorkDraft) {
    if (this.state.busy || this.state.ambiguous) return null;
    const input = this.state.input ?? { ...draft, requestId: this.state.requestId };
    this.update({ ...this.state, input, busy: true, error: null });
    const result = await this.start(input).catch(
      (error: unknown): NoteReply<NotesStartWorkResult> => ({ ok: false, error }),
    );
    this.update({
      ...this.state,
      busy: false,
      ambiguous: !result.ok && isAmbiguousLaunch(result.error),
      error: result.ok ? null : noteErrorMessage(result.error),
    });
    return result;
  }
  startAgain(requestId: string) {
    if (this.state.busy) return;
    this.update({ requestId, input: null, busy: false, ambiguous: false, error: null });
  }
}

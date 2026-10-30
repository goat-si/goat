import type { NoteEditorInbound, NoteEditorOutbound } from "./note-editor-protocol";
import { applyNoteEditorChanges } from "./note-editor-support";

type EditorReport = Extract<NoteEditorOutbound, { type: "change" | "doc" }>;
export type NoteEditorReceipt =
  | { readonly kind: "value"; readonly value: string; readonly checkbox: boolean }
  | { readonly kind: "send"; readonly message: NoteEditorInbound }
  | { readonly kind: "ignore" };

// More unacknowledged values than this means React stopped adopting them; resync instead.
const MAX_LAG = 64;

/**
 * React Native's copy of the editor text. The page numbers its edits within a generation, so a
 * dropped or reordered edit asks for the whole text instead of silently diverging.
 */
export class NoteEditorBridge {
  private known: string;
  private generation = 0;
  private seq = 0;
  private awaitingDoc = false;
  /** Values handed to React that it may not have rendered yet. */
  private reported: string[] = [];

  constructor(value: string) {
    this.known = value;
  }

  /** Reconciles a rendered value; anything not an echo of the page replaces its text. */
  sync(value: string): NoteEditorInbound | null {
    if (value === this.known) {
      this.reported = [];
      return null;
    }
    const lag = this.reported.indexOf(value);
    if (lag >= 0) {
      this.reported = this.reported.slice(lag + 1);
      return null;
    }
    this.generation++;
    this.seq = 0;
    this.known = value;
    this.reported = [];
    this.awaitingDoc = false;
    return { type: "setDoc", generation: this.generation, doc: value };
  }

  receive(message: EditorReport): NoteEditorReceipt {
    if (message.generation !== this.generation) return { kind: "ignore" };
    if (message.type === "doc") {
      this.awaitingDoc = false;
      this.seq = message.seq;
      return this.accept(message.doc, false);
    }
    if (this.awaitingDoc) return { kind: "ignore" };
    const next =
      message.seq === this.seq + 1
        ? applyNoteEditorChanges(this.known, message.changes, message.length)
        : null;
    if (next === null) {
      this.awaitingDoc = true;
      return { kind: "send", message: { type: "requestDoc" } };
    }
    this.seq = message.seq;
    return this.accept(next, message.checkbox);
  }

  private accept(value: string, checkbox: boolean): NoteEditorReceipt {
    this.known = value;
    this.reported.push(value);
    if (this.reported.length > MAX_LAG) this.reported.shift();
    return { kind: "value", value, checkbox };
  }
}

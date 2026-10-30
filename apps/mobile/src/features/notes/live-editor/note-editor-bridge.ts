import type { NoteEditorInbound, NoteEditorOutbound } from "./note-editor-protocol";
import { applyNoteEditorChanges } from "./note-editor-support";

type EditorChange = Extract<NoteEditorOutbound, { type: "change" }>;
type EditorReport = EditorChange | Extract<NoteEditorOutbound, { type: "doc" }>;
export interface NoteEditorReceipt {
  /** The new text for React, when it changed. */
  readonly value?: { readonly text: string; readonly checkbox: boolean };
  /** A message the page must receive. */
  readonly send?: NoteEditorInbound;
}

// More unacknowledged values than this means React stopped adopting them; resync instead.
const MAX_LAG = 64;
// Edits buffered while a snapshot is outstanding; past this, ask again in case it was lost.
const RESEND_AFTER = 100;
const requestDoc = { type: "requestDoc" } as const;

/**
 * React Native's copy of the editor text. The page numbers its edits within a generation, so a
 * dropped or reordered edit asks for the whole text instead of silently diverging.
 */
export class NoteEditorBridge {
  private known: string;
  private generation = 0;
  private seq = 0;
  private awaitingDoc = false;
  /** Edits that arrived while a snapshot was outstanding; newer ones replay on top of it. */
  private buffered: EditorChange[] = [];
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
    this.buffered = [];
    return { type: "setDoc", generation: this.generation, doc: value };
  }

  receive(message: EditorReport): NoteEditorReceipt {
    if (message.generation !== this.generation) return {};
    if (message.type === "doc") return this.snapshot(message.doc, message.seq);
    if (this.awaitingDoc) {
      this.buffered.push(message);
      return this.buffered.length % RESEND_AFTER === 0 ? { send: requestDoc } : {};
    }
    const next = this.apply(message);
    if (next === null) return this.resync();
    return this.accept(next, message.checkbox);
  }

  private snapshot(doc: string, seq: number): NoteEditorReceipt {
    if (!this.awaitingDoc) return {};
    this.awaitingDoc = false;
    this.known = doc;
    this.seq = seq;
    let checkbox = false;
    const newer = this.buffered.filter((change) => change.seq > seq).sort((a, b) => a.seq - b.seq);
    this.buffered = [];
    for (const change of newer) {
      const next = this.apply(change);
      if (next === null) return { ...this.accept(this.known, false), ...this.resync() };
      this.known = next;
      checkbox ||= change.checkbox;
    }
    return this.accept(this.known, checkbox);
  }

  private apply(change: EditorChange) {
    if (change.seq !== this.seq + 1) return null;
    const next = applyNoteEditorChanges(this.known, change.changes, change.length);
    if (next !== null) this.seq = change.seq;
    return next;
  }

  private resync(): NoteEditorReceipt {
    this.awaitingDoc = true;
    this.buffered = [];
    return { send: requestDoc };
  }

  private accept(text: string, checkbox: boolean): NoteEditorReceipt {
    this.known = text;
    this.reported.push(text);
    if (this.reported.length > MAX_LAG) this.reported.shift();
    return { value: { text, checkbox } };
  }
}

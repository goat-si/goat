export type NoteLineBreak = "\n" | "\r\n";

export type NoteEditorCommand =
  | "bold"
  | "italic"
  | "heading"
  | "bullet"
  | "task"
  | "undo"
  | "redo"
  | "toggleSource"
  | "focus"
  | "blur";

export interface NoteEditorTheme {
  readonly background: string;
  readonly text: string;
  readonly strong: string;
  readonly muted: string;
  readonly link: string;
  readonly accent: string;
  readonly codeBackground: string;
  readonly codeText: string;
  readonly quoteBorder: string;
  readonly rule: string;
  readonly dark: boolean;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly headingSizes: ReadonlyArray<number>;
}

export interface NoteEditorConfig {
  /** False when this person cannot change the note at all. */
  readonly editable: boolean;
  /** True while a save or delete is running; keeps focus and the keyboard. */
  readonly readOnly: boolean;
  readonly theme: NoteEditorTheme;
}

export interface NoteEditorInit {
  readonly doc: string;
  readonly generation: number;
  readonly lineBreak: NoteLineBreak;
  readonly config: NoteEditorConfig;
}

/** One replacement in the previous string, as [from, to, insert] in UTF-16 offsets. */
export type NoteEditorChange = readonly [number, number, string];

export type NoteEditorInbound =
  | { readonly type: "setDoc"; readonly generation: number; readonly doc: string }
  | { readonly type: "config"; readonly config: NoteEditorConfig }
  | { readonly type: "command"; readonly command: NoteEditorCommand }
  /** `id` names one recovery; the page echoes it so a late reply to an older one is ignored. */
  | { readonly type: "requestDoc"; readonly id: number };

export type NoteEditorOutbound =
  | { readonly type: "ready"; readonly bootMs: number }
  | {
      readonly type: "change";
      readonly generation: number;
      /** Numbers this page's edits within a generation, starting at 1. */
      readonly seq: number;
      readonly changes: ReadonlyArray<NoteEditorChange>;
      readonly length: number;
      readonly checkbox: boolean;
    }
  | {
      readonly type: "doc";
      /** The requestDoc this answers. */
      readonly id: number;
      readonly generation: number;
      readonly seq: number;
      readonly doc: string;
      /** Recent sequence numbers in this generation that were checkbox taps. */
      readonly checkboxSeqs: ReadonlyArray<number>;
    }
  | { readonly type: "focus"; readonly focused: boolean }
  | { readonly type: "source"; readonly source: boolean }
  | { readonly type: "link"; readonly href: string }
  | { readonly type: "error"; readonly message: string };

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isChange = (value: unknown): value is NoteEditorChange =>
  Array.isArray(value) &&
  value.length === 3 &&
  isCount(value[0]) &&
  isCount(value[1]) &&
  typeof value[2] === "string";

/** Checks every field: the page renders note text, so its messages are untrusted input. */
export function parseNoteEditorMessage(data: string): NoteEditorOutbound | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const message: Record<string, unknown> = { ...value };
  const { type } = message;
  switch (type) {
    case "ready":
      return isCount(message.bootMs) ? { type, bootMs: message.bootMs } : null;
    case "change": {
      const { generation, seq, changes, length, checkbox } = message;
      return isCount(generation) &&
        isCount(seq) &&
        isCount(length) &&
        typeof checkbox === "boolean" &&
        Array.isArray(changes) &&
        changes.every(isChange)
        ? { type, generation, seq, changes, length, checkbox }
        : null;
    }
    case "doc": {
      const { id, generation, seq, doc, checkboxSeqs } = message;
      return isCount(id) &&
        isCount(generation) &&
        isCount(seq) &&
        typeof doc === "string" &&
        Array.isArray(checkboxSeqs) &&
        checkboxSeqs.every(isCount)
        ? { type, id, generation, seq, doc, checkboxSeqs }
        : null;
    }
    case "focus":
      return typeof message.focused === "boolean" ? { type, focused: message.focused } : null;
    case "source":
      return typeof message.source === "boolean" ? { type, source: message.source } : null;
    case "link":
      return typeof message.href === "string" && message.href.length > 0
        ? { type, href: message.href }
        : null;
    case "error":
      return typeof message.message === "string" ? { type, message: message.message } : null;
    default:
      return null;
  }
}

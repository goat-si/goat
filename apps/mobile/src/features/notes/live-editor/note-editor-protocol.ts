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
  | { readonly type: "requestDoc" };

export type NoteEditorOutbound =
  | { readonly type: "ready"; readonly bootMs: number }
  | {
      readonly type: "change";
      readonly generation: number;
      readonly changes: ReadonlyArray<NoteEditorChange>;
      readonly length: number;
      readonly checkbox: boolean;
    }
  | { readonly type: "doc"; readonly generation: number; readonly doc: string }
  | { readonly type: "focus"; readonly focused: boolean }
  | { readonly type: "source"; readonly source: boolean }
  | { readonly type: "link"; readonly href: string }
  | { readonly type: "error"; readonly message: string };

const outboundTypes = new Set(["ready", "change", "doc", "focus", "source", "link", "error"]);

export function parseNoteEditorMessage(data: string): NoteEditorOutbound | null {
  try {
    const value: unknown = JSON.parse(data);
    if (typeof value !== "object" || value === null || !("type" in value)) return null;
    return typeof value.type === "string" && outboundTypes.has(value.type)
      ? (value as NoteEditorOutbound)
      : null;
  } catch {
    return null;
  }
}

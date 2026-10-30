import {
  history,
  historyKeymap,
  defaultKeymap,
  insertNewlineKeepIndent,
  redo,
  undo,
} from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import {
  Annotation,
  ChangeSet,
  EditorSelection,
  EditorState,
  Transaction,
  type ChangeSpec,
  type Extension,
  type StateCommand,
  type Text,
  type TransactionSpec,
} from "@codemirror/state";
import { keymap } from "@codemirror/view";
import type { NoteEditorChange, NoteEditorCommand, NoteLineBreak } from "./note-editor-protocol";
import { noteMarkdown } from "./note-editor-language";

/** Marks a change that came from React Native, so it is not echoed back. */
export const remoteChange = Annotation.define<boolean>();
/** Marks a checkbox tap, which saves at once when the note is not being edited. */
export const checkboxChange = Annotation.define<boolean>();

/** The editor's real text; Text.toString always joins with "\n". */
export const noteText = (state: EditorState) => state.sliceDoc();

// Pasted or dictated text can carry other line breaks; give it the note's own.
const lineBreakNormalizer = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;
  let foreign = false;
  tr.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
    for (let lines = inserted.iterLines(); !foreign && !lines.next().done;)
      foreign = /[\r\n]/.test(lines.value);
  });
  if (!foreign) return tr;
  const { startState } = tr;
  const specs: ChangeSpec[] = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const text = inserted.sliceString(0, inserted.length, "\n").split(/\r\n?|\n/);
    specs.push({
      from: fromA,
      to: toA,
      insert: startState.toText(text.join(startState.lineBreak)),
    });
  });
  const changes = ChangeSet.of(specs, startState.doc.length);
  return {
    changes,
    selection: startState.selection.map(changes, 1),
    scrollIntoView: tr.scrollIntoView,
    annotations: [Transaction.userEvent.of(tr.annotation(Transaction.userEvent) ?? "input")],
  };
});

function touchedLines(state: EditorState) {
  const lines = new Map<number, ReturnType<Text["line"]>>();
  for (const range of state.selection.ranges)
    for (
      let number = state.doc.lineAt(range.from).number;
      number <= state.doc.lineAt(range.to).number;
      number++
    )
      lines.set(number, state.doc.line(number));
  const all = [...lines.values()];
  // A multi-line selection skips blank lines so a list does not gain empty items.
  return all.length > 1 ? all.filter((line) => line.text.trim() !== "") : all;
}

function lineCommand(
  build: (lines: ReturnType<typeof touchedLines>) => ChangeSpec[],
  userEvent: string,
): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false;
    const changes = build(touchedLines(state));
    if (changes.length === 0) return false;
    dispatch(state.update({ changes, scrollIntoView: true, userEvent }));
    return true;
  };
}

export function toggleInlineMark(mark: string): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false;
    const size = mark.length;
    const spec = state.changeByRange((range) => {
      const outside =
        state.sliceDoc(range.from - size, range.from) === mark &&
        state.sliceDoc(range.to, range.to + size) === mark;
      if (outside)
        return {
          changes: [
            { from: range.from - size, to: range.from },
            { from: range.to, to: range.to + size },
          ],
          range: EditorSelection.range(range.from - size, range.to - size),
        };
      const text = state.sliceDoc(range.from, range.to);
      if (text.length >= size * 2 && text.startsWith(mark) && text.endsWith(mark))
        return {
          changes: [
            { from: range.from, to: range.from + size },
            { from: range.to - size, to: range.to },
          ],
          range: EditorSelection.range(range.from, range.to - size * 2),
        };
      return {
        changes: [
          { from: range.from, insert: mark },
          { from: range.to, insert: mark },
        ],
        range: EditorSelection.range(range.from + size, range.to + size),
      };
    });
    dispatch(state.update(spec, { scrollIntoView: true, userEvent: "input.format" }));
    return true;
  };
}

export const cycleHeading = lineCommand(
  (lines) =>
    lines.map((line) => {
      const match = /^(#{1,6})(?:[ \t]+|$)/.exec(line.text);
      if (!match) return { from: line.from, insert: "# " };
      const level = match[1]!.length;
      return level >= 3
        ? { from: line.from, to: line.from + match[0].length }
        : { from: line.from, to: line.from + level, insert: "#".repeat(level + 1) };
    }),
  "input.format",
);

const bulletPattern = /^([ \t]*)([-*+])([ \t]+)(\[[ xX]\](?:[ \t]+|$))?/;
const listPattern = /^([ \t]*)([-*+]|(\d{1,9})([.)]))([ \t]+)(\[[ xX]\](?:[ \t]+|$))?/;

export const toggleBulletList = lineCommand((lines) => {
  const bullets = lines.map((line) => bulletPattern.exec(line.text));
  if (bullets.every(Boolean))
    return lines.map((line, index) => {
      const match = bullets[index]!;
      return { from: line.from + match[1]!.length, to: line.from + match[0].length };
    });
  return lines.flatMap((line, index) => {
    if (bullets[index]) return [];
    const ordered = listPattern.exec(line.text);
    const indent = /^[ \t]*/.exec(line.text)![0].length;
    return ordered?.[3]
      ? [{ from: line.from + indent, to: line.from + indent + ordered[2]!.length, insert: "-" }]
      : [{ from: line.from + indent, insert: "- " }];
  });
}, "input.format");

export const toggleTaskList = lineCommand((lines) => {
  const items = lines.map((line) => listPattern.exec(line.text));
  if (items.every((item) => item?.[6]))
    return lines.map((line, index) => {
      const item = items[index]!;
      const start = line.from + item[0].length - item[6]!.length;
      return { from: start, to: line.from + item[0].length };
    });
  return lines.flatMap((line, index) => {
    const item = items[index];
    if (item?.[6]) return [];
    if (item) return [{ from: line.from + item[0].length, insert: "[ ] " }];
    const indent = /^[ \t]*/.exec(line.text)![0].length;
    return [{ from: line.from + indent, insert: "- [ ] " }];
  });
}, "input.format");

/** Flips the one character inside a task marker that starts at pos. */
export function toggleTaskAt(state: EditorState, pos: number): TransactionSpec | null {
  const marker = state.sliceDoc(pos, pos + 3);
  if (!/^\[[ xX]\]$/.test(marker)) return null;
  return {
    changes: { from: pos + 1, to: pos + 2, insert: marker[1] === " " ? "x" : " " },
    annotations: [checkboxChange.of(true), Transaction.userEvent.of("input.toggle")],
  };
}

function inCode(state: EditorState, pos: number) {
  for (let node = syntaxTree(state).resolveInner(pos, -1); node.parent; node = node.parent)
    if (node.name === "FencedCode" || node.name === "CodeBlock") return true;
  return false;
}

/** Enter in a list item starts the next item; on an empty item it removes the marker. */
export const continueMarkdownList: StateCommand = ({ state, dispatch }) => {
  const range = state.selection.main;
  if (state.readOnly || state.selection.ranges.length > 1 || !range.empty) return false;
  const line = state.doc.lineAt(range.head);
  const match = listPattern.exec(line.text);
  if (!match || range.head < line.from + match[0].length || inCode(state, range.head)) return false;
  if (line.text.slice(match[0].length).trim() === "" && range.head === line.to) {
    dispatch(
      state.update({
        changes: { from: line.from, to: line.to },
        selection: { anchor: line.from },
        userEvent: "delete",
      }),
    );
    return true;
  }
  const marker = match[3] ? String(Number(match[3]) + 1) + match[4] : match[2];
  const insert = state.lineBreak + match[1] + marker + match[5] + (match[6] ? "[ ] " : "");
  dispatch(
    state.update({
      changes: { from: range.head, insert },
      selection: { anchor: range.head + state.toText(insert).length },
      scrollIntoView: true,
      userEvent: "input",
    }),
  );
  return true;
};

export const noteEditorCommands: Record<
  Exclude<NoteEditorCommand, "toggleSource" | "focus" | "blur">,
  StateCommand
> = {
  bold: toggleInlineMark("**"),
  italic: toggleInlineMark("_"),
  heading: cycleHeading,
  bullet: toggleBulletList,
  task: toggleTaskList,
  undo,
  redo,
};

export function noteEditorExtensions(lineBreak: NoteLineBreak): Extension {
  return [
    EditorState.lineSeparator.of(lineBreak),
    lineBreakNormalizer,
    noteMarkdown,
    history(),
    keymap.of([
      { key: "Enter", run: (view) => continueMarkdownList(view) || insertNewlineKeepIndent(view) },
      { key: "Mod-b", run: noteEditorCommands.bold },
      { key: "Mod-i", run: noteEditorCommands.italic },
      { key: "Mod-Alt-1", run: noteEditorCommands.heading },
      { key: "Mod-Shift-8", run: noteEditorCommands.bullet },
      { key: "Mod-Shift-9", run: noteEditorCommands.task },
      ...historyKeymap,
      ...defaultKeymap,
    ]),
  ];
}

/** Editor changes as replacements in the previous string. */
export function noteEditorChanges(startDoc: Text, changes: ChangeSet, lineBreak: NoteLineBreak) {
  const extra = lineBreak.length - 1;
  const offset = (pos: number) => pos + extra * (startDoc.lineAt(pos).number - 1);
  const result: NoteEditorChange[] = [];
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    result.push([offset(fromA), offset(toA), inserted.sliceString(0, inserted.length, lineBreak)]);
  });
  return result;
}

export const noteTextLength = (doc: Text, lineBreak: NoteLineBreak) =>
  doc.length + (lineBreak.length - 1) * (doc.lines - 1);

/** The smallest replacement that turns the editor text into next, so the cursor survives. */
export function replaceNoteText(state: EditorState, next: string): TransactionSpec | null {
  const current = noteText(state);
  if (current === next) return null;
  let start = 0;
  const limit = Math.min(current.length, next.length);
  while (start < limit && current.charCodeAt(start) === next.charCodeAt(start)) start++;
  let end = 0;
  while (
    end < limit - start &&
    current.charCodeAt(current.length - 1 - end) === next.charCodeAt(next.length - 1 - end)
  )
    end++;
  // Never split a CRLF pair or a surrogate pair at either edge.
  const splits = (text: string, at: number) =>
    (text[at - 1] === "\r" && text[at] === "\n") ||
    (/[\uD800-\uDBFF]/.test(text[at - 1] ?? "") && /[\uDC00-\uDFFF]/.test(text[at] ?? ""));
  while (start > 0 && (splits(current, start) || splits(next, start))) start--;
  while (end > 0 && (splits(current, current.length - end) || splits(next, next.length - end)))
    end--;
  const extra = state.lineBreak.length - 1;
  const position = (offset: number) =>
    offset - extra * (current.slice(0, offset).split(state.lineBreak).length - 1);
  return {
    changes: {
      from: position(start),
      to: position(current.length - end),
      insert: next.slice(start, next.length - end),
    },
    annotations: [remoteChange.of(true), Transaction.addToHistory.of(false)],
  };
}

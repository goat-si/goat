import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, placeholder } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import "./note-editor.css";
import type {
  NoteEditorConfig,
  NoteEditorInbound,
  NoteEditorInit,
  NoteEditorOutbound,
} from "./note-editor-protocol";
import { liveTapHandlers, livePreview } from "./note-editor-live-preview";
import {
  checkboxChange,
  noteEditorChanges,
  noteEditorCommands,
  noteEditorExtensions,
  noteText,
  noteTextLength,
  remoteChange,
  replaceNoteText,
} from "./note-editor-state";

declare global {
  interface Window {
    ReactNativeWebView: { postMessage: (message: string) => void };
    __goatNoteEditor?: NoteEditorInit;
  }
}

const post = (message: NoteEditorOutbound) =>
  window.ReactNativeWebView?.postMessage(JSON.stringify(message));

const codeHighlight = HighlightStyle.define([
  {
    tag: [tags.keyword, tags.operatorKeyword, tags.modifier, tags.controlKeyword],
    color: "var(--goat-code-keyword)",
  },
  {
    tag: [tags.string, tags.special(tags.string), tags.regexp, tags.inserted],
    color: "var(--goat-code-string)",
  },
  {
    tag: [tags.number, tags.bool, tags.null, tags.atom, tags.deleted],
    color: "var(--goat-code-number)",
  },
  {
    tag: [
      tags.function(tags.variableName),
      tags.typeName,
      tags.className,
      tags.definition(tags.variableName),
    ],
    color: "var(--goat-code-definition)",
  },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    color: "var(--goat-muted)",
    fontStyle: "italic",
  },
]);

function applyTheme(config: NoteEditorConfig) {
  const { theme } = config;
  const style = document.documentElement.style;
  style.colorScheme = theme.dark ? "dark" : "light";
  const variables: Record<string, string> = {
    bg: theme.background,
    text: theme.text,
    strong: theme.strong,
    muted: theme.muted,
    link: theme.link,
    accent: theme.accent,
    "code-bg": theme.codeBackground,
    "code-text": theme.codeText,
    quote: theme.quoteBorder,
    rule: theme.rule,
    "font-size": theme.fontSize + "px",
    "line-height": theme.lineHeight + "px",
    "code-keyword": theme.dark ? "#c4b5fd" : "#7c3aed",
    "code-string": theme.dark ? "#86efac" : "#15803d",
    "code-number": theme.dark ? "#fcd34d" : "#b45309",
    "code-definition": theme.dark ? "#93c5fd" : "#1d4ed8",
  };
  theme.headingSizes.forEach((size, index) => (variables["h" + (index + 1)] = size + "px"));
  for (const [name, value] of Object.entries(variables)) style.setProperty("--goat-" + name, value);
}

const access = (config: NoteEditorConfig) => [
  EditorView.editable.of(config.editable),
  EditorState.readOnly.of(config.readOnly || !config.editable),
];

function boot(init: NoteEditorInit) {
  const parent = document.getElementById("editor");
  if (!parent) return;
  let generation = init.generation;
  let seq = 0;
  // Lets React Native recognize a checkbox tap that only reached it through a snapshot.
  const checkboxSeqs: number[] = [];
  let source = false;
  // Replacing text or reconfiguring mid-composition can drop the syllable being composed.
  let deferredDoc: Extract<NoteEditorInbound, { type: "setDoc" }> | null = null;
  let deferredConfig: NoteEditorConfig | null = null;
  const { lineBreak } = init;
  const accessCompartment = new Compartment();
  const previewCompartment = new Compartment();
  applyTheme(init.config);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: init.doc,
      extensions: [
        noteEditorExtensions(lineBreak),
        accessCompartment.of(access(init.config)),
        previewCompartment.of(livePreview),
        liveTapHandlers((href) => post({ type: "link", href })),
        syntaxHighlighting(codeHighlight),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({
          spellcheck: "true",
          autocorrect: "on",
          autocapitalize: "sentences",
          "aria-label": "Note",
        }),
        placeholder("Write your note"),
        EditorView.updateListener.of((update) => {
          for (const tr of update.transactions) {
            if (!tr.docChanged || tr.annotation(remoteChange)) continue;
            post({
              type: "change",
              generation,
              seq: ++seq,
              changes: noteEditorChanges(tr.startState.doc, tr.changes, lineBreak),
              length: noteTextLength(tr.state.doc, lineBreak),
              checkbox: tr.annotation(checkboxChange) === true,
            });
            if (tr.annotation(checkboxChange) === true) {
              checkboxSeqs.push(seq);
              if (checkboxSeqs.length > 256) checkboxSeqs.shift();
            }
          }
          if (update.focusChanged) post({ type: "focus", focused: update.view.hasFocus });
          if (!update.view.composing && (deferredDoc || deferredConfig))
            queueMicrotask(applyDeferred);
        }),
      ],
    }),
  });

  let resizeFrame = 0;
  const keepCursorVisible = () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      if (view.hasFocus)
        view.dispatch({
          effects: EditorView.scrollIntoView(view.state.selection.main.head, {
            y: "nearest",
            yMargin: 32,
          }),
        });
    });
  };
  window.addEventListener("resize", keepCursorVisible);
  window.visualViewport?.addEventListener("resize", keepCursorVisible);

  function applyDeferred() {
    if (view.composing) return;
    if (deferredDoc) {
      const message = deferredDoc;
      deferredDoc = null;
      generation = message.generation;
      seq = 0;
      checkboxSeqs.length = 0;
      const spec = replaceNoteText(view.state, message.doc);
      if (spec) view.dispatch(spec);
    }
    if (deferredConfig) {
      const config = deferredConfig;
      deferredConfig = null;
      applyTheme(config);
      view.dispatch({ effects: accessCompartment.reconfigure(access(config)) });
    }
  }
  view.contentDOM.addEventListener("compositionend", () => setTimeout(applyDeferred));

  const receive = (event: Event) => {
    let message: NoteEditorInbound;
    try {
      message = JSON.parse(String((event as MessageEvent).data)) as NoteEditorInbound;
    } catch {
      return;
    }
    switch (message.type) {
      case "setDoc":
        deferredDoc = message;
        if (!view.composing) applyDeferred();
        return;
      case "config":
        deferredConfig = message.config;
        if (!view.composing) applyDeferred();
        return;
      case "requestDoc":
        post({
          type: "doc",
          id: message.id,
          generation,
          seq,
          doc: noteText(view.state),
          checkboxSeqs,
        });
        return;
      case "command":
        switch (message.command) {
          case "focus":
            view.focus();
            return;
          case "blur":
            view.contentDOM.blur();
            return;
          case "toggleSource":
            source = !source;
            view.dispatch({ effects: previewCompartment.reconfigure(source ? [] : livePreview) });
            post({ type: "source", source });
            return;
          default:
            noteEditorCommands[message.command](view);
            view.focus();
        }
    }
  };
  window.addEventListener("message", receive);
  document.addEventListener("message", receive);
  requestAnimationFrame(() => post({ type: "ready", bootMs: Math.round(performance.now()) }));
}

window.addEventListener("error", (event) =>
  post({ type: "error", message: String(event.message) }),
);
// Android may inject the initial state after this script runs; wait for it then.
if (window.__goatNoteEditor) boot(window.__goatNoteEditor);
else
  Object.defineProperty(window, "__goatNoteEditor", {
    configurable: true,
    set(init: NoteEditorInit) {
      Object.defineProperty(window, "__goatNoteEditor", { value: init, configurable: true });
      boot(init);
    },
  });

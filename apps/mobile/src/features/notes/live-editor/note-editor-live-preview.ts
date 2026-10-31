import { syntaxTree } from "@codemirror/language";
import type { EditorState, Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import type { SyntaxNodeRef, Tree } from "@lezer/common";
import { noteLinkDefinitions, normalizeLinkLabel } from "./note-editor-links";
import { toggleTaskAt } from "./note-editor-state";

const definitionsByTree = new WeakMap<Tree, ReadonlyMap<string, string>>();
function linkDefinitions(state: EditorState) {
  const tree = syntaxTree(state);
  let definitions = definitionsByTree.get(tree);
  if (!definitions) {
    definitions = noteLinkDefinitions(tree, (from, to) => state.doc.sliceString(from, to));
    definitionsByTree.set(tree, definitions);
  }
  return definitions;
}

class BulletWidget extends WidgetType {
  override eq() {
    return true;
  }
  toDOM() {
    const bullet = document.createElement("span");
    bullet.className = "cm-goat-bullet";
    bullet.textContent = "•";
    return bullet;
  }
}

class TaskWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  override eq(other: TaskWidget) {
    return other.checked === this.checked;
  }
  toDOM() {
    const box = document.createElement("span");
    box.className = this.checked ? "cm-goat-task cm-goat-task-checked" : "cm-goat-task";
    box.setAttribute("role", "checkbox");
    box.setAttribute("aria-checked", String(this.checked));
    return box;
  }
  override ignoreEvent() {
    return false;
  }
}

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super();
  }
  override eq(other: ImageWidget) {
    return other.src === this.src && other.alt === this.alt;
  }
  toDOM() {
    const label = document.createElement("span");
    label.className = "cm-goat-image-label";
    label.textContent = this.alt || "Image";
    // Note-relative paths live in the hub's repository, which this page cannot read.
    if (!/^(?:https?:|data:image\/)/i.test(this.src)) return label;
    const image = document.createElement("img");
    image.className = "cm-goat-image";
    image.alt = this.alt;
    image.src = this.src;
    image.onerror = () => image.replaceWith(label);
    return image;
  }
  override ignoreEvent() {
    return false;
  }
}

const hiddenMark = Decoration.replace({});
const bullet = Decoration.replace({ widget: new BulletWidget() });
const marks = {
  strong: Decoration.mark({ class: "cm-goat-strong" }),
  em: Decoration.mark({ class: "cm-goat-em" }),
  strike: Decoration.mark({ class: "cm-goat-strike" }),
  code: Decoration.mark({ class: "cm-goat-code" }),
  link: Decoration.mark({ class: "cm-goat-link" }),
  meta: Decoration.mark({ class: "cm-goat-meta" }),
  done: Decoration.mark({ class: "cm-goat-done" }),
};

/** A YAML frontmatter block at the start, which markdown would misread as a rule and heading. */
function frontmatterEnd(state: EditorState) {
  const head = state.doc.sliceString(0, Math.min(state.doc.length, 20_000));
  return /^---[ \t]*\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?=\n|$)/.exec(head)?.[0].length ?? 0;
}

function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  const { doc } = state;
  const revealed = new Set<number>();
  if (view.hasFocus)
    for (const range of state.selection.ranges)
      for (let line = doc.lineAt(range.from).number; line <= doc.lineAt(range.to).number; line++)
        revealed.add(line);
  const shown = (pos: number) => revealed.has(doc.lineAt(pos).number);
  const lineClasses = new Map<number, Set<string>>();
  // Only visible lines get classes, so a long block costs what is on screen, not its length.
  const addLines = (from: number, to: number, className: string) => {
    for (const visible of view.visibleRanges) {
      const end = Math.min(to, visible.to);
      for (let pos = Math.max(from, visible.from); pos <= end;) {
        const line = doc.lineAt(pos);
        const classes = lineClasses.get(line.from) ?? new Set<string>();
        classes.add(className);
        lineClasses.set(line.from, classes);
        pos = line.to + 1;
      }
    }
  };
  const ranges: Range<Decoration>[] = [];
  const replaced: Array<readonly [number, number]> = [];
  const replace = (from: number, to: number, decoration = hiddenMark) => {
    // Plugin decorations may not replace line breaks, and replacements may not overlap.
    if (from >= to || doc.lineAt(from).number !== doc.lineAt(to).number) return;
    if (replaced.some(([start, end]) => from < end && to > start)) return;
    replaced.push([from, to]);
    ranges.push(decoration.range(from, to));
  };
  const mark = (from: number, to: number, decoration: Decoration) => {
    if (from < to) ranges.push(decoration.range(from, to));
  };
  const spaceAfter = (pos: number) => (/[ \t]/.test(doc.sliceString(pos, pos + 1)) ? 1 : 0);
  const frontmatter = frontmatterEnd(state);
  if (frontmatter > 0) addLines(0, frontmatter, "cm-goat-frontmatter");

  const visit = (node: SyntaxNodeRef): boolean | void => {
    if (node.name !== "Document" && node.from < frontmatter) return false;
    const heading = /^ATXHeading(\d)$/.exec(node.name) ?? /^SetextHeading(\d)$/.exec(node.name);
    if (heading) {
      addLines(node.from, node.from, "cm-goat-h" + heading[1]);
      return;
    }
    switch (node.name) {
      case "HeaderMark": {
        if (node.node.parent?.name.startsWith("Setext")) {
          if (!shown(node.from)) addLines(node.from, node.from, "cm-goat-setext-mark");
          return;
        }
        if (shown(node.from)) return;
        const atStart = doc.lineAt(node.from).from === node.from;
        if (atStart) replace(node.from, node.to + spaceAfter(node.to));
        else replace(node.from - (spaceAfter(node.from - 1) ? 1 : 0), node.to);
        return;
      }
      case "StrongEmphasis":
        mark(node.from, node.to, marks.strong);
        return;
      case "Emphasis":
        mark(node.from, node.to, marks.em);
        return;
      case "Strikethrough":
        mark(node.from, node.to, marks.strike);
        return;
      case "EmphasisMark":
      case "StrikethroughMark":
      case "CodeMark":
        if (!shown(node.from)) replace(node.from, node.to);
        return;
      case "InlineCode":
        mark(node.from, node.to, marks.code);
        return;
      case "Link":
      case "Image": {
        const linkMarks = node.node.getChildren("LinkMark");
        const url = node.node.getChild("URL");
        const open = linkMarks[0];
        const close = linkMarks[1];
        if (!url && open && close && node.name === "Link" && !shown(node.from)) {
          // [text][label], [text][] and [text] take their target from a definition.
          const label = node.node.getChild("LinkLabel");
          const text = doc.sliceString(open.to, close.from);
          const named = label ? doc.sliceString(label.from + 1, label.to - 1) : "";
          const href = text.startsWith("^")
            ? undefined
            : linkDefinitions(state).get(normalizeLinkLabel(named || text));
          if (href) {
            replace(open.from, open.to);
            replace(close.from, node.to);
            mark(
              open.to,
              close.from,
              Decoration.mark({ class: "cm-goat-link", attributes: { "data-href": href } }),
            );
            return;
          }
        }
        if (!url || !open || !close || shown(node.from)) {
          mark(
            node.from,
            node.to,
            doc.sliceString(node.from, node.from + 2) === "[^" ? marks.meta : marks.link,
          );
          return node.name === "Image" ? false : undefined;
        }
        const href = doc.sliceString(url.from, url.to);
        if (node.name === "Image") {
          replace(
            node.from,
            node.to,
            Decoration.replace({
              widget: new ImageWidget(href, doc.sliceString(open.to, close.from)),
            }),
          );
          return false;
        }
        replace(open.from, open.to);
        replace(close.from, node.to);
        mark(
          open.to,
          close.from,
          Decoration.mark({ class: "cm-goat-link", attributes: { "data-href": href } }),
        );
        return;
      }
      case "Autolink": {
        const url = node.node.getChild("URL");
        if (url)
          mark(
            url.from,
            url.to,
            Decoration.mark({
              class: "cm-goat-link",
              attributes: { "data-href": doc.sliceString(url.from, url.to) },
            }),
          );
        if (!shown(node.from))
          for (const linkMark of node.node.getChildren("LinkMark"))
            replace(linkMark.from, linkMark.to);
        return false;
      }
      case "URL":
        // GFM's bare links; URLs inside links and definitions are handled by their parent.
        mark(
          node.from,
          node.to,
          Decoration.mark({
            class: "cm-goat-link",
            attributes: { "data-href": doc.sliceString(node.from, node.to) },
          }),
        );
        return;
      case "Blockquote":
        addLines(node.from, node.to, "cm-goat-quote");
        return;
      case "QuoteMark":
        if (!shown(node.from)) replace(node.from, node.to + spaceAfter(node.to));
        return;
      case "ListMark": {
        const task = node.node.nextSibling?.name === "Task";
        if (node.node.parent?.parent?.name !== "BulletList") {
          mark(node.from, node.to, marks.meta);
          return;
        }
        if (shown(node.from)) return;
        if (task) replace(node.from, node.to + spaceAfter(node.to));
        else replace(node.from, node.to, bullet);
        return;
      }
      case "Task": {
        const marker = node.node.getChild("TaskMarker");
        if (marker && /x/i.test(doc.sliceString(marker.from, marker.to)))
          mark(marker.to, node.to, marks.done);
        return;
      }
      case "TaskMarker": {
        const touched =
          view.hasFocus &&
          state.selection.ranges.some((range) => range.from <= node.to && range.to >= node.from);
        if (!touched)
          replace(
            node.from,
            node.to,
            Decoration.replace({
              widget: new TaskWidget(/x/i.test(doc.sliceString(node.from, node.to))),
            }),
          );
        return;
      }
      case "FencedCode": {
        addLines(node.from, node.to, "cm-goat-codeblock");
        addLines(node.from, node.from, "cm-goat-fence");
        const last = node.node.lastChild;
        if (
          last?.name === "CodeMark" &&
          doc.lineAt(last.from).number !== doc.lineAt(node.from).number
        )
          addLines(last.from, last.from, "cm-goat-fence");
        return false;
      }
      case "CodeBlock":
        addLines(node.from, node.to, "cm-goat-codeblock");
        return false;
      case "HorizontalRule":
        if (!shown(node.from)) {
          addLines(node.from, node.from, "cm-goat-hr");
          replace(node.from, node.to);
        }
        return;
      case "Table":
        addLines(node.from, node.to, "cm-goat-table");
        return;
      case "TableHeader":
        mark(node.from, node.to, marks.strong);
        return;
      case "TableDelimiter":
        mark(node.from, node.to, marks.meta);
        return;
      case "HTMLBlock":
      case "CommentBlock":
      case "ProcessingInstructionBlock":
        addLines(node.from, node.to, "cm-goat-html");
        return false;
      case "HTMLTag":
      case "Comment":
      case "LinkReference":
        mark(node.from, node.to, marks.meta);
        return false;
    }
  };
  const tree = syntaxTree(state);
  for (const { from, to } of view.visibleRanges) tree.iterate({ from, to, enter: visit });
  for (const [from, classes] of lineClasses)
    ranges.push(Decoration.line({ class: [...classes].join(" ") }).range(from));
  return Decoration.set(ranges, true);
}

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(update: ViewUpdate) {
      // Rebuilding around a composing syllable can break Hangul composition; map instead.
      if (update.view.composing) {
        this.decorations = this.decorations.map(update.changes);
        return;
      }
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        update.focusChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      )
        this.decorations = buildDecorations(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** Taps on rendered checkboxes and links act without moving the cursor or opening the keyboard. */
export function liveTapHandlers(onLink: (href: string) => void) {
  let touch: { x: number; y: number } | null = null;
  const activate = (view: EditorView, target: EventTarget | null) => {
    if (!(target instanceof Element)) return false;
    const task = target.closest(".cm-goat-task");
    if (task) {
      if (view.state.readOnly) return true;
      const spec = toggleTaskAt(view.state, view.posAtDOM(task));
      if (spec) view.dispatch(spec);
      return true;
    }
    const href = target.closest("[data-href]")?.getAttribute("data-href");
    if (!href) return false;
    onLink(href);
    return true;
  };
  return EditorView.domEventHandlers({
    touchstart(event) {
      const point = event.touches[0];
      touch = event.touches.length === 1 && point ? { x: point.clientX, y: point.clientY } : null;
      return false;
    },
    touchmove(event) {
      const point = event.touches[0];
      if (touch && point && Math.hypot(point.clientX - touch.x, point.clientY - touch.y) > 10)
        touch = null;
      return false;
    },
    touchend(event, view) {
      if (!touch) return false;
      touch = null;
      if (!activate(view, event.target)) return false;
      event.preventDefault();
      return true;
    },
    mousedown(event, view) {
      if (event.button !== 0 || !activate(view, event.target)) return false;
      event.preventDefault();
      return true;
    },
  });
}

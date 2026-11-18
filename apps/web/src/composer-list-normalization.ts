import { combineTransactionSteps, getChangedRanges } from "@tiptap/core";
import { isHistoryTransaction } from "@tiptap/pm/history";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { canJoin, findWrapping } from "@tiptap/pm/transform";
import { parseListPrefix } from "./composer-list-prefix";

/** Only changed top-level paragraphs can acquire a literal list prefix outside an input rule. */
export function listNormalizationPlugin(isComposing: () => boolean) {
  let pending = new Set<number>();
  const key = new PluginKey("composerListNormalization");
  return new Plugin({
    key,
    props: {
      handleDOMEvents: {
        // ProseMirror tags the DOM flush after compositionend as composition, so nothing else would normalize.
        compositionend(view) {
          setTimeout(() => {
            if (!view.isDestroyed && !view.composing && pending.size > 0) {
              view.dispatch(view.state.tr);
            }
          });
          return false;
        },
      },
    },
    appendTransaction(transactions, oldState, state) {
      // Tiptap's undoInputRule (Backspace right after a rule) restores the typed text on purpose.
      const undoesInputRule = oldState.plugins.some(
        (plugin) => plugin.spec.isInputRules && plugin.getState(oldState),
      );
      if (undoesInputRule || transactions.some(isHistoryTransaction)) {
        pending.clear();
        return null;
      }
      if (pending.size === 0 && !transactions.some((tr) => tr.docChanged)) return null;
      const changes = combineTransactionSteps(oldState.doc, [...transactions]);
      pending = new Set(
        [...pending].flatMap((pos) => {
          const mapped = changes.mapping.mapResult(pos, 1);
          return mapped.deleted ? [] : [mapped.pos];
        }),
      );
      for (const { newRange } of getChangedRanges(changes)) {
        state.doc.nodesBetween(newRange.from, newRange.to, (node, pos) => {
          if (node.type.name !== "paragraph") return false;
          const parsed = parseListPrefix(paragraphText(node));
          // Typing after a marker left literal keeps it literal; only an edit reaching the marker converts.
          if (parsed && newRange.from <= pos + 1 + parsed.markerLength) pending.add(pos);
          return false;
        });
      }
      // The next non-composition transaction can normalize after the browser finishes its DOM edits.
      if (isComposing() || transactions.some((tr) => tr.getMeta("composition") != null))
        return null;

      const tr = state.tr;
      for (const pos of [...pending].sort((a, b) => b - a)) {
        pending.delete(pos);
        if (state.doc.resolve(pos).depth !== 0) continue;
        const node = state.doc.nodeAt(pos);
        if (node?.type.name !== "paragraph") continue;
        const text = paragraphText(node);
        const parsed = parseListPrefix(text);
        // Input rules only introduce unindented top-level lists; keep the same boundary here.
        if (!parsed || parsed.prefix.indent) continue;
        const { prefix, markerLength } = parsed;
        if (
          Object.values(state.schema.marks).some((mark) => node.rangeHasMark(0, markerLength, mark))
        )
          continue;
        const active = state.selection.$from.depth === 1 && state.selection.$from.before(1) === pos;
        const content = text.slice(markerLength);
        // Keep `- ` and unfinished task markers literal while the user is entering the gesture.
        if (
          active &&
          (prefix.kind === "task"
            ? !prefix.contentSpace
            : prefix.kind === "bullet" &&
              prefix.marker === "-" &&
              (!content || /^\[(?:[ xX]\]?)?$/.test(content)))
        ) {
          pending.add(pos);
          continue;
        }
        if (prefix.kind !== "task" && !prefix.space) continue;
        const listType =
          state.schema.nodes[
            prefix.kind === "task"
              ? "taskList"
              : prefix.kind === "ordered"
                ? "orderedList"
                : "bulletList"
          ];
        if (!listType) continue;
        const attrs =
          prefix.kind === "ordered" ? { start: Number.parseInt(prefix.marker, 10) || 1 } : {};
        const $from = tr.doc.resolve(pos + 1);
        const range = $from.blockRange();
        const wrapping = range && findWrapping(range, listType, attrs);
        if (!range || !wrapping) continue;
        tr.wrap(range, wrapping);
        tr.setNodeMarkup(
          pos + 1,
          undefined,
          prefix.kind === "task"
            ? {
                checked: prefix.checked,
                indent: prefix.indent,
                markerSpace: prefix.markerSpace,
                contentSpace: prefix.contentSpace,
              }
            : { indent: prefix.indent, marker: prefix.marker, space: prefix.space },
        );
        tr.delete(pos + 3, pos + 3 + markerLength);
        const wrapped = tr.doc.nodeAt(pos);
        if (wrapped) joinCompatibleLists(tr, pos + wrapped.nodeSize);
        joinCompatibleLists(tr, pos);
      }
      pending = new Set([...pending].map((pos) => tr.mapping.map(pos, 1)));
      return tr.docChanged ? tr : null;
    },
  });
}

function paragraphText(node: ProseMirrorNode): string {
  return node.textBetween(0, node.content.size, undefined, "\ufffc");
}

/** Rebuilding from Markdown merges adjacent lists of one type whose markers share a delimiter. */
function joinCompatibleLists(tr: Transaction, pos: number): void {
  const $pos = tr.doc.resolve(pos);
  const before = $pos.nodeBefore;
  const after = $pos.nodeAfter;
  const delimiter = (list: ProseMirrorNode) =>
    String(list.firstChild?.attrs.marker ?? "").slice(-1);
  if (
    before &&
    after &&
    before.type === after.type &&
    delimiter(before) === delimiter(after) &&
    canJoin(tr.doc, pos)
  ) {
    tr.join(pos);
  }
}

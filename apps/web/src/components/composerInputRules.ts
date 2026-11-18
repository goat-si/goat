import { InputRule, wrappingInputRule } from "@tiptap/core";
import type { NodeType } from "@tiptap/pm/model";

import { convertBulletItemToTask } from "~/composer-rich-text-doc";

/** Wait for a character after '- ' so task markers reach their input rule before becoming bullets. */
export function listMarkerInputRule(
  find: RegExp,
  listType: "bulletList" | "orderedList",
): InputRule {
  return new InputRule({
    find,
    handler: ({ state, range, match, chain }) => {
      const marker = match.groups?.marker ?? "-";
      const space = match.groups?.space ?? " ";
      const carried = match.groups?.carried ?? "";
      // Nested lists would serialize flat, so accept only top-level paragraphs.
      const $from = state.doc.resolve(range.from);
      if ($from.parent.type.name !== "paragraph" || $from.depth !== 1) return null;
      const command = chain()
        .deleteRange(range)
        .wrapInList(
          listType,
          listType === "orderedList" ? { start: Number.parseInt(marker, 10) || 1 } : {},
        )
        .updateAttributes("listItem", { marker, space });
      (carried ? command.insertContent(carried) : command).run();
      return undefined;
    },
  });
}

export const bulletToTaskInputRule = new InputRule({
  find: /^\[([ xX])\] $/,
  handler: ({ state, range, match, chain }) => {
    const $from = state.doc.resolve(range.from);
    const item = $from.node(-1);
    if ($from.parent.type.name !== "paragraph" || item?.type.name !== "listItem") return null;
    if (!["-", "*", "+"].includes((item.attrs as { marker?: string }).marker ?? "")) return null;
    const checked = (match[1] ?? " ").toLowerCase() === "x";
    chain()
      .command(({ tr }) => {
        convertBulletItemToTask(tr, range.from, range.to, checked);
        return true;
      })
      .run();
    return undefined;
  },
});

export function taskInputRule(type: NodeType): InputRule {
  const rule = wrappingInputRule({
    find: /^- \[([ xX])\] $/,
    type,
    getAttributes: (match) => ({ checked: match[1]?.toLowerCase() === "x" }),
  });
  return new InputRule({
    find: rule.find,
    handler: (props) =>
      props.state.doc.resolve(props.range.from).depth === 1 ? rule.handler(props) : null,
  });
}

export const blockquoteInputRule = new InputRule({
  find: /^>(\s)$/,
  handler: ({ state, range, match, chain }) => {
    const $from = state.doc.resolve(range.from);
    if ($from.parent.type.name !== "paragraph" || $from.depth !== 1) return null;
    chain()
      .deleteRange(range)
      .wrapIn("blockquote", { prefix: `>${match[1] ?? " "}` })
      .run();
    return undefined;
  },
});

/** Require a space after *** or ___ to preserve bold typing. Lists and quotes cannot serialize rules. */
export const horizontalRuleInputRule = new InputRule({
  find: /^(---|\*\*\*|___)\s?$/,
  handler: ({ state, range, match, chain }) => {
    const source = match[0] ?? "---";
    if (!source.startsWith("---") && !/\s$/.test(source)) return null;
    const $from = state.doc.resolve(range.from);
    if ($from.parent.type.name !== "paragraph" || $from.depth !== 1) return null;
    chain()
      .deleteRange(range)
      .setHorizontalRule()
      .command(({ tr }) => {
        const $pos = tr.selection.$from;
        const index = $pos.index(0) - 1;
        if (index < 0) return true;
        const rulePos = $pos.posAtIndex(index, 0);
        const rule = tr.doc.nodeAt(rulePos);
        if (rule?.type.name === "horizontalRule") {
          tr.setNodeMarkup(rulePos, undefined, { ...rule.attrs, source });
        }
        return true;
      })
      .run();
    return undefined;
  },
});

/** Require a space to preserve PR references; lists and quotes cannot serialize headings. */
export const headingInputRule = new InputRule({
  find: /^(#{1,6})(\s)$/,
  handler: ({ state, range, match, chain }) => {
    const $from = state.doc.resolve(range.from);
    if ($from.parent.type.name !== "paragraph" || $from.depth !== 1) return null;
    chain()
      .deleteRange(range)
      .setNode("heading", { level: match[1]?.length ?? 1, space: match[2] ?? " " })
      .run();
    return undefined;
  },
});

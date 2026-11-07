import { defineRule, type ESTree } from "@oxlint/plugins";

/** Controls whose box is their hit area and hover fill, so a negative margin overlaps a neighbour. */
const CONTROLS = new Set(["Button", "ComposerControl", "Toggle", "button"]);
/** Props that style a control's own trigger box. */
const CONTROL_CLASS_PROPS = new Set(["triggerClassName"]);
const NEGATIVE_INLINE_MARGIN = /^-m[xselr]?-/u;

function parseClass(token: string) {
  let depth = 0;
  let start = 0;
  const variants: string[] = [];
  for (let index = 0; index < token.length; index++) {
    const character = token[index];
    if (character === "[" || character === "(") depth++;
    else if (character === "]" || character === ")") depth--;
    else if (character === ":" && depth === 0) {
      variants.push(token.slice(start, index));
      start = index + 1;
    }
  }
  return { variants, utility: token.slice(start).replace(/^!|!$/gu, "") };
}

function collectStrings(node: unknown, out: string[]) {
  if (Array.isArray(node)) {
    for (const child of node) collectStrings(child, out);
    return;
  }
  if (typeof node !== "object" || node === null || !("type" in node)) return;
  const current = node as ESTree.Node;
  if (current.type === "Literal" && typeof current.value === "string") out.push(current.value);
  if (current.type === "TemplateElement") out.push(current.value.cooked ?? current.value.raw);
  for (const [key, value] of Object.entries(current)) {
    if (key !== "parent") collectStrings(value, out);
  }
}

const elementName = (name: ESTree.JSXOpeningElement["name"]) =>
  name.type === "JSXIdentifier"
    ? name.name
    : name.type === "JSXMemberExpression"
      ? name.property.name
      : null;

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Space controls with the parent's gap, not negative margins that overlap a neighbour's hit area and hover fill.",
    },
  },
  create(context) {
    return {
      JSXAttribute(node) {
        if (node.name.type !== "JSXIdentifier" || node.value === null) return;
        const prop = node.name.name;
        const opening = node.parent;
        const owner = opening.type === "JSXOpeningElement" ? elementName(opening.name) : null;
        const onControl = prop === "className" && owner !== null && CONTROLS.has(owner);
        if (!onControl && !CONTROL_CLASS_PROPS.has(prop)) return;
        const strings: string[] = [];
        collectStrings(node.value, strings);
        for (const token of strings.join(" ").split(/\s+/u).filter(Boolean)) {
          const { variants, utility } = parseClass(token);
          // `[&_svg]:-mx-0.5` nudges a child inside the box; only the box's own margin overlaps.
          if (
            variants.some(
              (variant) => /^\[&(?:_|[>+~])/u.test(variant) || variant === "*" || variant === "**",
            )
          )
            continue;
          if (!NEGATIVE_INLINE_MARGIN.test(utility)) continue;
          context.report({
            node,
            message: `${token} pulls a control into its neighbour, so their hover fills and hit areas overlap. Space controls with the parent's gap and keep each control's padding symmetric (docs/internals/web-ui.md#control-rows).`,
          });
        }
      },
    };
  },
});

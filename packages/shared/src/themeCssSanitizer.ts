import { generate, lexer, parse, walk } from "css-tree";
import { THEME_CSS_MAX_LENGTH } from "@goat/contracts";
import { THEME_COLOR_ROLES } from "./themePalettes.ts";
import { ThemeCssResourceError } from "./themeCssErrors.ts";

export { THEME_CSS_MAX_LENGTH };

const SELECTORS = new Set(
  [
    '[data-slot="sidebar"]',
    '[data-slot="sidebar-inner"]',
    "[data-thread-item]",
    "[data-chat-header]",
    '[data-workspace-area="conversation"]',
    ".messages-timeline-scroll",
    "[data-timeline-row-kind]",
    '[data-message-role="user"]',
    "[data-user-message-bubble]",
    '[data-message-role="assistant"]',
    ".chat-markdown",
    ".chat-markdown-codeblock",
    "[data-chat-composer-form]",
    '[data-slot="composer-host"]',
    ".composer-tiptap",
    "[data-thread-details-card]",
    "[data-thread-terminal-drawer]",
    "[data-settings-page-scroll]",
    '[data-slot="button"]',
    '[data-slot="input"]',
    '[data-slot="switch"]',
    '[data-slot="select-trigger"]',
    '[data-slot="dialog-popup"]',
    '[data-slot="popover-popup"]',
    '[data-slot="menu-popup"]',
    '[data-slot="tooltip-popup"]',
  ].map((selector) => generate(parse(selector, { context: "selector" }))),
);
const SCOPED_SELECTORS = new Set(
  Array.from(SELECTORS, (selector) => `[data-goat-theme-root] ${selector}`),
);
const PROPERTIES = new Set([
  "color",
  "background-color",
  "border-color",
  "outline-color",
  "fill",
  "stroke",
  "opacity",
]);
const COLOR_FUNCTIONS = new Set([
  "rgb",
  "rgba",
  "hsl",
  "hsla",
  "hwb",
  "lab",
  "lch",
  "oklab",
  "oklch",
  "color",
]);
const VALUE_NODES = new Set([
  "Value",
  "Hash",
  "Identifier",
  "Function",
  "Number",
  "Percentage",
  "Operator",
]);
const RESOURCE_FUNCTIONS = new Set([
  "url",
  "image-set",
  "-webkit-image-set",
  "image",
  "cross-fade",
  "element",
  "src",
]);
const COLOR_VARIABLES = new Set(
  THEME_COLOR_ROLES.map(
    (role) =>
      `--app-theme-${Array.from(role, (character) => (character >= "A" && character <= "Z" ? `-${character.toLowerCase()}` : character)).join("")}`,
  ),
);

export function sanitizeThemeCss(css: string): string {
  if (css.length > THEME_CSS_MAX_LENGTH) throw new Error("Invalid theme CSS");
  if (css.includes("\\")) throw new ThemeCssResourceError();
  const ast = parse(css, {
    parseCustomProperty: true,
    onParseError: () => {
      throw new Error("Invalid theme CSS");
    },
  });
  if (ast.type !== "StyleSheet") throw new Error("Invalid theme CSS");
  const rules: string[] = [];
  ast.children.forEach((rule) => {
    if (rule.type === "Atrule") {
      if (["import", "font-face", "namespace"].includes(rule.name.toLowerCase()))
        throw new ThemeCssResourceError();
      throw new Error("Unsupported theme rule");
    }
    if (rule.type !== "Rule" || rule.prelude.type !== "SelectorList")
      throw new Error("Unsupported theme rule");
    const prelude = rule.prelude;
    const selectors: string[] = [];
    let customProperties = false;
    prelude.children.forEach((selector) => {
      const text = generate(selector);
      if (text === ":root" || text === "[data-goat-theme-root]") {
        if (prelude.children.toArray().length !== 1) throw new Error("Unsupported theme selector");
        customProperties = true;
        selectors.push("[data-goat-theme-root]");
      } else {
        if (SCOPED_SELECTORS.has(text)) selectors.push(text);
        else if (SELECTORS.has(text)) selectors.push(`[data-goat-theme-root] ${text}`);
        else throw new Error("Unsupported theme selector");
      }
    });
    const declarations: string[] = [];
    rule.block.children.forEach((declaration) => {
      if (declaration.type !== "Declaration") throw new Error("Unsupported theme property");
      walk(declaration.value, (node) => {
        if (
          node.type === "Url" ||
          node.type === "String" ||
          (node.type === "Function" && RESOURCE_FUNCTIONS.has(node.name.toLowerCase()))
        )
          throw new ThemeCssResourceError();
      });
      if (
        !(customProperties
          ? COLOR_VARIABLES.has(declaration.property)
          : PROPERTIES.has(declaration.property)) ||
        declaration.value.type !== "Value"
      )
        throw new Error("Unsupported theme property");
      walk(declaration.value, (node) => {
        if (
          !VALUE_NODES.has(node.type) ||
          (node.type === "Function" && !COLOR_FUNCTIONS.has(node.name.toLowerCase()))
        )
          throw new Error("Unsupported theme value");
      });
      if (
        lexer.matchProperty(customProperties ? "color" : declaration.property, declaration.value)
          .error
      )
        throw new Error("Invalid theme value");
      declarations.push(generate(declaration));
    });
    rules.push(`${selectors.join(",")}{${declarations.join(";")}}`);
  });
  const result = rules.join("\n");
  if (result.length > THEME_CSS_MAX_LENGTH) throw new Error("Theme CSS is too large");
  return result;
}

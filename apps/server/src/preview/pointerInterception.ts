const tags = new Set([
  "div",
  "span",
  "button",
  "input",
  "a",
  "dialog",
  "section",
  "aside",
  "iframe",
  "label",
  "p",
  "main",
  "header",
  "footer",
  "nav",
  "body",
  "html",
]);
const roles = new Set([
  "dialog",
  "alertdialog",
  "button",
  "menu",
  "menuitem",
  "tooltip",
  "banner",
  "navigation",
  "complementary",
]);

export const pointerInterception = (message: string) => {
  const line = message.split("\n").findLast((line) => line.includes("intercepts pointer events"));
  if (!line) return undefined;
  const tag = /<([a-z][a-z0-9-]*)\b/i.exec(line)?.[1]?.toLowerCase();
  const role = /\brole="([a-z]+)"/.exec(line)?.[1];
  return `Pointer intercepted by ${tag && tags.has(tag) ? `<${tag}>` : "an element"}${role && roles.has(role) ? ` (${role})` : ""}.`;
};

// Isolated-world scripts: the page's own script cannot replace what they read.
export const FOCUSED = `function () {
  let element = document.activeElement;
  while (element && element.shadowRoot && element.shadowRoot.activeElement)
    element = element.shadowRoot.activeElement;
  return element;
}`;
export const SELECTED = `function (selector) {
  const found = [];
  const visit = (root) => {
    found.push(...root.querySelectorAll(selector));
    for (const element of root.querySelectorAll("*")) if (element.shadowRoot) visit(element.shadowRoot);
  };
  visit(document);
  return found.length === 1 ? found[0] : found.length;
}`;

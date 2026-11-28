// Bridge (docs/PROVENANCE.md): lifted v1 ui primitives portal their popups to <body>; GOAT 2 scopes v1 CSS to
// [data-v1], so a portal without an explicit container mounts into one [data-v1][data-v1-portal] root instead.
let root: HTMLElement | null = null;

/** The single [data-v1][data-v1-portal] element under document.body, created on first use. */
export function v1PortalRoot(): HTMLElement {
  if (root && root.isConnected) return root;
  root = document.querySelector<HTMLElement>("body > [data-v1-portal]");
  if (!root) {
    root = document.createElement("div");
    root.setAttribute("data-v1", "");
    root.setAttribute("data-v1-portal", "");
    // Viewport-sized like v1's <body> portal target (popups size and position against it) but transparent to the
    // pointer; seam/v1-entry.css gives its descendants pointer-events back.
    root.style.cssText = "position:fixed;inset:0;overflow:visible;pointer-events:none";
    document.body.appendChild(root);
  }
  return root;
}

/** Portal props with a missing or undefined container (v1 tooltip passes container={undefined}) pointed at the v1 root. */
export function withV1Container<P extends { container?: unknown }>(props: P): P {
  return props.container === undefined ? { ...props, container: v1PortalRoot() } : props;
}

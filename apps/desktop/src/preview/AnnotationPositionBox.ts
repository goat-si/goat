import type { PreviewAnnotationRect } from "@goat/contracts";

export function positionBox(node: HTMLElement, rect: PreviewAnnotationRect): void {
  if (rect.width <= 0 || rect.height <= 0) {
    node.style.display = "none";
    return;
  }
  node.style.display = "block";
  node.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
  node.style.width = `${rect.width}px`;
  node.style.height = `${rect.height}px`;
}

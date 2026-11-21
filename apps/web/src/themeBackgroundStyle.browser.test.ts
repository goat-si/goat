import { expect, it } from "vite-plus/test";
import "./index.css";

it("shows a published background behind the conversation surface", () => {
  const root = document.documentElement;
  const previous = root.getAttribute("data-published-background");
  const oldImage = root.style.getPropertyValue("--theme-background-image");
  const conversation = document.createElement("div");
  conversation.setAttribute("data-workspace-area", "conversation");
  document.body.append(conversation);
  try {
    root.dataset.publishedBackground = "true";
    root.style.setProperty("--theme-background-image", 'url("data:image/png;base64,iVBORw0KGgo=")');
    expect(getComputedStyle(conversation).backgroundImage).toContain("data:image/png");
  } finally {
    conversation.remove();
    if (previous === null) root.removeAttribute("data-published-background");
    else root.setAttribute("data-published-background", previous);
    if (oldImage) root.style.setProperty("--theme-background-image", oldImage);
    else root.style.removeProperty("--theme-background-image");
  }
});

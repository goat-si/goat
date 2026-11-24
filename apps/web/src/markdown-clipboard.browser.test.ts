import { expect, it } from "vite-plus/test";
import { chatMarkdownClipboardPayload } from "./markdown-clipboard";

it("copies items within a list with their visible markers", () => {
  const root = document.createElement("div");
  root.innerHTML = "<ol><li>Install</li><li>Configure</li><li>Deploy</li></ol>";
  document.body.append(root);
  try {
    const items = root.querySelectorAll("li");
    const range = document.createRange();
    range.setStart(items[1]!.firstChild!, 0);
    range.setEnd(items[2]!.firstChild!, "Deploy".length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(chatMarkdownClipboardPayload(selection)?.text).toBe("2. Configure\n3. Deploy");
    selection.removeAllRanges();
  } finally {
    root.remove();
  }
});

import type { Editor } from "@tiptap/core";
import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act } from "../../test/render";
import { serializeEditorDoc } from "~/composer-rich-text-doc";
import { mountEditor } from "./ComposerPromptEditorTiptap.input.test-support";

it.each([
  ["**DEV**", "**DEV**!"],
  ["*DEV*", "*DEV*!"],
  ["~~DEV~~", "~~DEV~~!"],
  ["`DEV`", "`DEV`!"],
  ["***DEV***", "***DEV***!"],
])("types after the closing markers of pasted %s", async (pasted, typed) => {
  await using screen = await mountEditor("");
  const { editor } = screen;
  await act(async () => {
    editor.view.focus();
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", pasted);
    editor.view.dom.dispatchEvent(new ClipboardEvent("paste", { clipboardData, cancelable: true }));
  });
  await userEvent.keyboard("!");
  expect(serializeEditorDoc(editor.state.doc).value).toBe(typed);
});

it("sends pasted signal expression as pasted", async () => {
  const pasted = "signal = (7 * 2**3 * 5)**4";
  await using screen = await mountEditor("");
  const { editor } = screen;
  await act(async () => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", pasted);
    editor.view.dom.dispatchEvent(new ClipboardEvent("paste", { clipboardData, cancelable: true }));
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe(pasted);
});

// regression: #31079 paste rules restyled dropped text, and dropped Markdown skipped the composer's parser
it.each([
  // Shown bold like the same paste; the sent text stays verbatim.
  ["signal = (7 * 2**3 * 5)**4", "signal = (7 * 23 * 5)4"],
  ["a **bold** and *soft* word", "a bold and soft word"],
])("drops %s like a paste", async (dropped, shown) => {
  await using screen = await mountEditor("");
  const { editor } = screen;
  await act(async () => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/plain", dropped);
    const { left, top } = editor.view.coordsAtPos(1);
    editor.view.dom.dispatchEvent(
      new DragEvent("drop", {
        dataTransfer,
        clientX: left,
        clientY: top + 1,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe(dropped);
  expect(editor.state.doc.textContent).toBe(shown);
  expect(editor.view.hasFocus()).toBe(true);
});

it("parses markdown dropped below the first line of an empty composer", async () => {
  await using screen = await mountEditor("");
  const { editor } = screen;
  const box = editor.view.dom.getBoundingClientRect();
  await act(async () => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/plain", "a **bold** word");
    editor.view.dom.dispatchEvent(
      new DragEvent("drop", {
        dataTransfer,
        clientX: box.left + 4,
        clientY: box.bottom - 1,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe("a **bold** word");
  expect(editor.state.doc.textContent).toBe("a bold word");
});

it("drops plain text on a new line below the last line", async () => {
  await using screen = await mountEditor("before");
  const { editor } = screen;
  const box = editor.view.dom.getBoundingClientRect();
  await act(async () => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/plain", "Docs https://example.com/document\n\nsecond");
    dataTransfer.setData("text/html", '<a href="https://example.com/document">Docs</a>');
    editor.view.dom.dispatchEvent(
      new DragEvent("drop", {
        dataTransfer,
        clientX: box.left + 4,
        clientY: box.bottom - 1,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe(
    "before\nDocs https://example.com/document\n\nsecond",
  );
  await act(async () => {
    editor.commands.undo();
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe("before");
});

it("drops text on a list marker inside the list", async () => {
  await using screen = await mountEditor("- one\n- two");
  const { editor } = screen;
  const item = editor.view.dom.querySelectorAll("li")[1]!.getBoundingClientRect();
  await act(async () => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/plain", "added");
    editor.view.dom.dispatchEvent(
      new DragEvent("drop", {
        dataTransfer,
        clientX: item.left - 8,
        clientY: item.top + item.height / 2,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(serializeEditorDoc(editor.state.doc).value).toMatch(/^- one\n.*added[\s\S]*- two$/);
});

it("drops text on a rule's edge without replacing the rule", async () => {
  await using screen = await mountEditor("before\n\n---\n\nafter");
  const { editor } = screen;
  let rulePos = -1;
  editor.state.doc.forEach((node, offset) => {
    if (node.type.name === "horizontalRule") rulePos = offset;
  });
  const rule = (editor.view.nodeDOM(rulePos) as HTMLElement).getBoundingClientRect();
  await act(async () => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/plain", "dropped");
    editor.view.dom.dispatchEvent(
      new DragEvent("drop", {
        dataTransfer,
        clientX: rule.left + rule.width / 2,
        clientY: rule.top,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  const value = serializeEditorDoc(editor.state.doc).value;
  expect(value).toContain("---");
  expect(value).toContain("dropped");
});

function typeText(editor: Editor, from: number, to: number, text: string) {
  const insert = () => editor.state.tr.insertText(text, from, to);
  if (
    !editor.view.someProp("handleTextInput", (handler) =>
      handler(editor.view, from, to, text, insert),
    )
  ) {
    editor.view.dispatch(insert());
  }
}

it.each([
  { code: "echo @prod next", from: 11, to: 16, expected: "echo @prod( next)" },
  { code: "echo next @prod", from: 1, to: 11, expected: "(echo next )@prod" },
])(
  "wraps selected code next to a literal mention in $code",
  async ({ code, from, to, expected }) => {
    await using screen = await mountEditor(`\`\`\`\n${code}\n\`\`\``);
    const { editor } = screen;
    await act(async () => {
      editor.commands.setTextSelection({ from, to });
      typeText(editor, from, to, "(");
    });
    expect(serializeEditorDoc(editor.state.doc).value).toBe(`\`\`\`\n${expected}\n\`\`\``);
  },
);

it("keeps replacement behavior at a prose mention boundary", async () => {
  await using screen = await mountEditor("echo @prod next");
  const { editor } = screen;
  await act(async () => {
    editor.commands.setTextSelection({ from: 7, to: 12 });
    typeText(editor, 7, 12, "(");
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe("echo @prod(");
});

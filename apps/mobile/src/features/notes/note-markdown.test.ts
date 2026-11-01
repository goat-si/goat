import { beforeAll, expect, it } from "@effect/vitest";
import { toggleNoteCheckbox } from "@goat/client-runtime/notes";
import { applyNoteCheckboxEvent, parsedNoteCheckboxes } from "./note-markdown";
import createMd4cModule from "../../../node_modules/react-native-enriched-markdown/src/web/wasm/md4c.js";
import type { ASTNode } from "../../../node_modules/react-native-enriched-markdown/src/web/types";

let nativeTaskTexts: (markdown: string) => string[];
let nativeTaskStates: (markdown: string) => boolean[];
beforeAll(async () => {
  // The shipped WASM uses the same MD4CParser as both native clients.
  const module = await createMd4cModule();
  const parse = module.cwrap("parseMarkdown", "string", ["string", ...Array(8).fill("number")]);
  const renderText = (node: ASTNode): string => {
    if (node.type === "SoftBreak") return " ";
    if (node.type === "LineBreak") return "\n";
    const content = node.content ?? node.children?.map(renderText).join("") ?? "";
    return (
      content + (["Paragraph", "Heading", "TableRow", "ListItem"].includes(node.type) ? "\n" : "")
    );
  };
  nativeTaskTexts = (markdown) => {
    const texts: string[] = [];
    const visit = (node: ASTNode) => {
      if (node.type === "ListItem" && node.attributes?.isTask === "true") {
        const first = node.children?.[0];
        texts.push(
          first && !["OrderedList", "UnorderedList"].includes(first.type)
            ? renderText(first).split("\n")[0]!.trim()
            : "",
        );
      }
      node.children?.forEach(visit);
    };
    visit(JSON.parse(String(parse(markdown, 0, 1, 0, 0, 0, 0, 0, 1))) as ASTNode);
    return texts;
  };
  nativeTaskStates = (markdown) => {
    const states: boolean[] = [];
    const visit = (node: ASTNode) => {
      // Both native renderers reserve the parent's task index before rendering children.
      if (node.type === "ListItem" && node.attributes?.isTask === "true")
        states.push(node.attributes.taskChecked === "true");
      node.children?.forEach(visit);
    };
    visit(JSON.parse(String(parse(markdown, 0, 1, 0, 0, 0, 0, 0, 1))) as ASTNode);
    return states;
  };
});

function applyNativeEvent(markdown: string, event: { index: number; checked: boolean }) {
  return applyNoteCheckboxEvent(markdown, {
    ...event,
    text: nativeTaskTexts(markdown)[event.index]!,
  });
}

function expectNativeSlots(markdown: string) {
  expect(parsedNoteCheckboxes(markdown).map((box) => box.checked)).toEqual(
    nativeTaskStates(markdown),
  );
}

it("maps nested and quoted GFM tasks to original source offsets without touching code or HTML", () => {
  const body =
    "# Work\r\n- [ ] **first**\r\n    - [x] nested\r\n> - [ ] quote\r\n\r\n```md\r\n- [ ] code\r\n```\r\n\r\n<pre>\r\n- [ ] raw code\r\n</pre>\r\n";
  expectNativeSlots(body);
  const boxes = parsedNoteCheckboxes(body);
  expect(boxes.map((box) => [box.label, box.checked])).toEqual([
    ["**first**", false],
    ["nested", true],
    ["quote", false],
  ]);
  expect(toggleNoteCheckbox(body, boxes[1]!.offset, boxes)).toBe(
    body.replace("[x] nested", "[ ] nested"),
  );
  expect(toggleNoteCheckbox(body, boxes[2]!.offset, boxes)).toBe(
    body.replace("[ ] quote", "[x] quote"),
  );
});
it("keeps the rest of a multiline task and unicode document byte-for-byte", () => {
  const body = "# 노트 🐐\n\n- [ ] 할 일\n  continued **markdown**\n\n1. [X] 완료";
  expectNativeSlots(body);
  const boxes = parsedNoteCheckboxes(body);
  expect(boxes).toHaveLength(2);
  expect(toggleNoteCheckbox(body, boxes[0]!.offset, boxes)).toBe(body.replace("[ ]", "[x]"));
});

it("uses the native new checked state and ignores duplicate and out-of-range events", () => {
  const before = "- [ ] task\n- [X] done";
  expectNativeSlots(before);
  const after = applyNativeEvent(before, { index: 0, checked: true });
  expect(after).toBe("- [x] task\n- [X] done");
  if (after === null) throw new Error("Expected the proven task to be editable");
  expect(applyNativeEvent(after, { index: 0, checked: true })).toBe(after);
  expect(applyNativeEvent(after, { index: 1, checked: false })).toBe("- [x] task\n- [ ] done");
  expect(applyNativeEvent(before, { index: 10, checked: true })).toBeNull();
});

it("maps a visible task past a footnote definition without editing the footnote", () => {
  const body = "[^a]:\n    - [ ] hidden\n\n- [ ] visible";
  expectNativeSlots(body);
  expect(parsedNoteCheckboxes(body).map((box) => box.label)).toEqual(["visible"]);
  expect(applyNativeEvent(body, { index: 0, checked: true })).toBe(
    "[^a]:\n    - [ ] hidden\n\n- [x] visible",
  );
});

it("keeps the empty parent's native index before its child and the last task", () => {
  const body = "- [ ]\n  - [ ] child\n- [ ] last";
  expectNativeSlots(body);
  expect(parsedNoteCheckboxes(body).map((box) => box.label)).toEqual(["", "child", "last"]);
  expect(applyNativeEvent(body, { index: 1, checked: true })).toBe(
    "- [ ]\n  - [x] child\n- [ ] last",
  );
  expect(applyNativeEvent(body, { index: 2, checked: true })).toBe(
    "- [ ]\n  - [ ] child\n- [x] last",
  );
});

it.each([
  ["empty unchecked", "- [ ]\n- [ ] visible", "- [ ]\n- [x] visible"],
  ["empty checked", "- [X]\n- [ ] visible", "- [X]\n- [x] visible"],
  ["empty ordered", "1. [ ]\n2. [ ] visible", "1. [ ]\n2. [x] visible"],
  ["empty quoted", "> - [ ]\n\n- [ ] visible", "> - [ ]\n\n- [x] visible"],
  ["empty CRLF", "- [ ]\r\n- [ ] visible", "- [ ]\r\n- [x] visible"],
] as const)("preserves native slots for %s tasks", (_name, body, expected) => {
  expectNativeSlots(body);
  expect(parsedNoteCheckboxes(body)).toHaveLength(2);
  expect(applyNativeEvent(body, { index: 1, checked: true })).toBe(expected);
});

it.each([
  ["indented code", "    - [ ] hidden\n\n- [ ] visible"],
  ["marker tabs becoming code", "- \t\t[ ] hidden\n\n- [ ] visible"],
  ["five marker spaces", "-     [ ] hidden\n\n- [ ] visible"],
  ["six marker spaces", "-      [ ] hidden\n\n- [ ] visible"],
  ["HTML pre", "<pre>\n- [ ] hidden\n</pre>\n\n- [ ] visible"],
  ["HTML comment", "<!--\n- [ ] hidden\n-->\n\n- [ ] visible"],
  ["backtick fence", "```md\n- [ ] hidden\n```\n\n- [ ] visible"],
  ["tilde fence", "~~~md\n- [ ] hidden\n~~~\n\n- [ ] visible"],
  ["longer closing fence", "```md\n- [ ] hidden\n`````\n\n- [ ] visible"],
  [
    "shorter non-closing fence",
    "````md\n- [ ] hidden\n```\n- [ ] hidden too\n````\n\n- [ ] visible",
  ],
  ["non-task blockquote", "> [ ] hidden\n\n- [ ] visible"],
  ["non-task list text", "- [ ]hidden\n\n- [ ] visible"],
] as const)("does not count %s as a native checkbox", (_name, body) => {
  expectNativeSlots(body);
  expect(parsedNoteCheckboxes(body).map((box) => box.label)).toEqual(["visible"]);
  expect(applyNativeEvent(body, { index: 0, checked: true })).toBe(
    body.replace("[ ] visible", "[x] visible"),
  );
});

it.each([
  ["CRLF", "# 노트 🐐\r\n\r\n- [ ] visible\r\n- [X] done\r\n"],
  ["multiline", "- [ ] visible\n  continuation **text**\n\n- [X] done"],
  ["lazy continuation", "- [ ] visible\ncontinuation without indent\n\n- [X] done"],
  ["quoted task", "> - [ ] visible\n> continuation\n\n- [X] done"],
  ["marker tab", "-\t[ ] visible\n- [X] done"],
  ["four marker spaces", "-    [ ] visible\n- [X] done"],
] as const)("preserves every other character for %s", (_name, body) => {
  expectNativeSlots(body);
  expect(parsedNoteCheckboxes(body)).toHaveLength(2);
  expect(applyNativeEvent(body, { index: 0, checked: true })).toBe(
    body.replace("[ ] visible", "[x] visible"),
  );
});

it.each(["===", "---", "| --- |"])(
  "keeps the native slot when a task's first content becomes %s",
  (underline) => {
    const body = `- [ ] title\n  ${underline}\n- [ ] last`;
    expect(nativeTaskStates(body)).toEqual([false, false]);
    expectNativeSlots(body);
    expect(parsedNoteCheckboxes(body).map((box) => box.label)).toEqual(["title", "last"]);
    expect(applyNativeEvent(body, { index: 0, checked: true })).toBe(
      body.replace("[ ] title", "[x] title"),
    );
    expect(applyNativeEvent(body, { index: 1, checked: true })).toBe(
      body.replace("[ ] last", "[x] last"),
    );
  },
);

it.each(["- \t\t[ ]", "-\t\t[ ]", "-   \t[ ]"])(
  "excludes an empty marker in tab-indented native code: %j",
  (code) => {
    const body = `${code}\n- [ ] visible`;
    expect(nativeTaskStates(body)).toEqual([false]);
    expectNativeSlots(body);
    expect(parsedNoteCheckboxes(body).map((box) => box.label)).toEqual(["visible"]);
    expect(applyNativeEvent(body, { index: 0, checked: true })).toBe(`${code}\n- [x] visible`);
    expect(applyNativeEvent(body, { index: 1, checked: true })).toBeNull();
  },
);

it.each(["", "> ", "> > ", "  ", "   ", "- parent\n  ", "1. parent\n   "])(
  "matches native tab columns for empty tasks after %j",
  (prefix) => {
    for (const marker of ["-", "1.", "100."]) {
      for (const padding of [" ", "    ", "\t", "\t ", " \t", "\t\t", " \t\t", "   \t", "     "]) {
        const body = `${prefix}${marker}${padding}[X]\n\n- [ ] visible`;
        expectNativeSlots(body);
        const states = nativeTaskStates(body);
        const visibleIndex = states.length - 1;
        expect(applyNativeEvent(body, { index: visibleIndex, checked: true })).toBe(
          body.replace("[ ] visible", "[x] visible"),
        );
        if (states[0])
          expect(applyNativeEvent(body, { index: 0, checked: false })).toBe(
            body.replace("[X]", "[ ]"),
          );
      }
    }
  },
);

it.each([
  [
    "footnote suppression after a list continuation",
    "- a\n[^a]:\n    - [ ] foot\n\n- [ ] last",
    0,
    "foot",
  ],
  ["tabbed blockquote code", ">\t- [ ] a\n>\t\n>\t    - [ ] b\n\n- [ ] c", 1, "c"],
  ["ordered task after indented code", "    a\n  2. [ ] b\n\n- [ ] c", 0, "b"],
] as const)("refuses an unproven native task for %s", (_name, body, index, text) => {
  expect(nativeTaskStates(body)).toEqual([false, false]);
  const event = { index, checked: true, text };
  expect(applyNoteCheckboxEvent(body, event)).toBeNull();
});

it("compares rendered formatting and whitespace instead of raw markdown labels", () => {
  const body = "- [ ] **bold** &amp; [link](https://example.com)\n  continued `code`";
  expect(
    applyNoteCheckboxEvent(body, {
      index: 0,
      checked: true,
      text: " bold & link  continued code ",
    }),
  ).toBe(body.replace("[ ]", "[x]"));
});

it("refuses duplicate rendered labels and missing native text", () => {
  const body = "- [ ] **same**\n- [ ] same";
  expect(applyNoteCheckboxEvent(body, { index: 0, checked: true, text: "same" })).toBeNull();
  expect(
    applyNoteCheckboxEvent("- [ ] task", { index: 0, checked: true, text: undefined! }),
  ).toBeNull();
});

it.each([
  ["hidden formatted duplicate", "- a\n[^a]:\n    - [ ] **same**\n\n- [ ] same", "same"],
  ["hidden literal duplicate", "- a\n[^a]:\n    - [ ] <div>\n\n- [ ] <div>", "<div>"],
  [
    "hidden fence duplicate",
    "1. parent\n   <span>\n   - [ ] span\n   </span>\n   \t *\t[ ] ```\n   +  [ ] ```\n\n- [ ] SENTINEL",
    "```",
  ],
] as const)(
  "refuses %s even when only one duplicate survived the JS slot rules",
  (_name, body, text) => {
    const index = text === "```" ? 1 : 0;
    expect(applyNoteCheckboxEvent(body, { index, checked: true, text })).toBeNull();
  },
);

it.each([
  ["full", "[same][ref]", "[ref]: /url"],
  ["collapsed", "[same][]", "[same]: /url"],
  ["shortcut", "[same]", "[same]: /url"],
  ["normalized reference", "[**same**][MY ref]", "[my   REF]: /url"],
] as const)(
  "refuses a hidden %s reference duplicate using document definitions",
  (_name, label, definition) => {
    const body = `- a\n[^a]:\n    - [ ] ${label}\n\n- [ ] same\n\n${definition}`;
    expect(nativeTaskTexts(body)).toEqual(["same", "same"]);
    expect(parsedNoteCheckboxes(body)).toHaveLength(1);
    expect(applyNativeEvent(body, { index: 0, checked: true })).toBeNull();
  },
);

it.each([
  ["separate tasks", "- [ ] Review\n- [ ] Review PR", 1, "[ ] Review PR", "[x] Review PR"],
  [
    "soft continuation",
    "- [ ] Review\n- [ ] Review\n  PR",
    1,
    "[ ] Review\n  PR",
    "[x] Review\n  PR",
  ],
  [
    "paragraph boundary",
    "- [ ] Review\n\n  PR\n- [ ] Review PR",
    1,
    "[ ] Review PR",
    "[x] Review PR",
  ],
  ["hard break", "- [ ] Review  \n  PR\n- [ ] Review PR", 1, "[ ] Review PR", "[x] Review PR"],
  [
    "reference labels",
    "- [ ] [Review][r]\n- [ ] [Review PR][r]\n\n[r]: /url",
    1,
    "[ ] [Review PR]",
    "[x] [Review PR]",
  ],
] as const)("allows complete distinct labels at a %s", (_name, body, index, before, after) => {
  expect(applyNativeEvent(body, { index, checked: true })).toBe(body.replace(before, after));
});

it("refuses a hidden reference duplicate with a soft continuation", () => {
  const body =
    "- a\n[^a]:\n    - [ ] [same][ref]\n      continued\n\n- [ ] same continued\n\n[ref]: /url";
  expect(nativeTaskTexts(body)).toEqual(["same continued", "same continued"]);
  expect(applyNativeEvent(body, { index: 0, checked: true })).toBeNull();
});

it.each([
  ["unproven continuation", "    - [ ] hidden\n    continuation\n\n- [ ] visible", 0],
  ["footnote reference", "- [ ] task[^a]\n- [ ] visible\n\n[^a]: note", 1],
  ["reference image", "- [ ] ![picture][ref]\n- [ ] visible\n\n[ref]: /image.png", 1],
] as const)("refuses when another candidate has an unknown label: %s", (_name, body, index) => {
  expect(nativeTaskTexts(body)[index]).toBe("visible");
  expect(applyNativeEvent(body, { index, checked: true })).toBeNull();
});

it("resolves document definitions even for a task-like marker in code", () => {
  const body = "    - [ ] [same][ref]\n\n- [ ] same\n\n[ref]: /url";
  expect(nativeTaskTexts(body)).toEqual(["same"]);
  expect(applyNativeEvent(body, { index: 0, checked: true })).toBeNull();
});

it("compares complete labels for task-like markers outside list nodes", () => {
  const body = "    - [ ] [Review][ref]\n\n- [ ] Review PR\n\n[ref]: /url";
  expect(nativeTaskTexts(body)).toEqual(["Review PR"]);
  expect(applyNativeEvent(body, { index: 0, checked: true })).toBe(
    body.replace("[ ] Review PR", "[x] Review PR"),
  );
});

it.each(["ref", "MY   ref", "a\\]b", "a&amp;b"])(
  "preserves reference identity without quote continuation prefixes: %s",
  (reference) => {
    const body = `    - [ ] [same][${reference}]\n\n- [ ] same\n\n> [${reference}]:\n>   /url`;
    expect(nativeTaskTexts(body)).toEqual(["same"]);
    expect(applyNativeEvent(body, { index: 0, checked: true })).toBeNull();
  },
);

it.each([
  ["numbered inline code", "1. [ ] Record `[x] done`\n2. [ ] Send report"],
  ["nested inline code", "- Work\n  1. [ ] Record `[x] done`\n  2. [ ] Send report"],
  ["numbered inline text", "1. [ ] Record [x] done\n2. [ ] Send report"],
  ["nested inline text", "- Work\n  1. [ ] Record [x] done\n  2. [ ] Send report"],
] as const)("toggles distinct tasks containing %s", (_name, body) => {
  expect(nativeTaskTexts(body)).toEqual(["Record [x] done", "Send report"]);
  expectNativeSlots(body);
  for (const [index, label] of ["Record", "Send report"].entries()) {
    expect(applyNativeEvent(body, { index, checked: true })).toBe(
      body.replace(`[ ] ${label}`, `[x] ${label}`),
    );
  }
});

it.each([
  ["image", "![diagram](/image.png)", ""],
  ["reference image", "![diagram][image]", "\n\n[image]: /image.png"],
  ["footnote", "detail[^a]", "\n\n[^a]: note"],
] as const)("stops label uncertainty at a hard break before a %s", (_name, content, definition) => {
  for (const hardBreak of ["  ", "\\"]) {
    const body = `- [ ] First${hardBreak}\n  ${content}\n- [ ] Send report${definition}`;
    expect(nativeTaskTexts(body)).toEqual(["First", "Send report"]);
    expectNativeSlots(body);
    for (const [index, label] of ["First", "Send report"].entries()) {
      expect(applyNativeEvent(body, { index, checked: true })).toBe(
        body.replace(`[ ] ${label}`, `[x] ${label}`),
      );
    }
  }
});

it.each([
  ["image", "![diagram](/image.png)", ""],
  ["footnote", "detail[^a]", "\n\n[^a]: note"],
] as const)("keeps uncertainty before a hard break for a %s", (_name, content, definition) => {
  const body = `- [ ] First ${content}  \n  continuation\n- [ ] Send report${definition}`;
  expect(nativeTaskTexts(body)[1]).toBe("Send report");
  expect(applyNativeEvent(body, { index: 1, checked: true })).toBeNull();
});

it("keeps task-like starts inside multiline backticks in the identity check", () => {
  const body = "    `before\n    - [ ] same\n    after`\n\n- [ ] same";
  expect(nativeTaskTexts(body)).toEqual(["same"]);
  expect(applyNativeEvent(body, { index: 0, checked: true })).toBeNull();
});

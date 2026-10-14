import { describe, expect, it } from "vite-plus/test";

import { pullRequestHoldReason } from "./pullRequestHold.ts";

const open = { isDraft: false, labels: [], body: "" };

describe("pullRequestHoldReason", () => {
  it("holds a draft", () => {
    expect(pullRequestHoldReason({ ...open, isDraft: true })).toBe("it is still a draft");
  });

  it.each([
    "HOLD",
    "hold",
    "On Hold",
    "do not merge",
    "DO-NOT-MERGE",
    "don't merge",
    "do_not_merge",
    "do - not - merge",
    "do--not--merge",
    "on - hold",
    "Do not merge!",
  ])("holds the %s label", (name) => {
    expect(pullRequestHoldReason({ ...open, labels: [{ name }] })).toBe(
      `it has the "${name}" label`,
    );
  });

  it.each([
    "HOLD: do not merge until Jun approves screenshots",
    "Summary\n\n**HOLD** until the API ships",
    "> HOLD — waiting on design",
    "- HOLD",
    "`HOLD`: do not merge",
    "1. HOLD: do not merge",
    "Steps\n\n2) **HOLD** for the release",
    "```sh\nnpm test\n```\n\nHOLD: after the fence",
    "<!-- template -->\nHOLD: after a comment",
    "<!--\nmultiline\n-->\nHOLD: after a comment",
    "> ```\n> example\n\nHOLD: stop",
    "- ```\n  example\nHOLD: after the list item",
    "- ```\n  > ```\n  ```\nHOLD: stop",
    "- ```\n    > ```\n  ```\nHOLD: stop",
    "- ~~~\n  > ~~~\n  ~~~\nHOLD: stop",
    "- item\n\n  ```\n  example\n\nHOLD: stop",
  ])("holds a description line %j", (body) => {
    expect(pullRequestHoldReason({ ...open, body })).toBe("its description has a HOLD line");
  });

  it.each([
    "Raises the threshold. Hold Cmd to select.",
    "The lease HOLDER now retries.",
    "We should hold off on the rename later.",
    "```\nHOLD: an example inside a fence\n```",
    "~~~~\n```\nHOLD: still fenced\n~~~~",
    "<!--\nHOLD: hidden in a template comment\n-->",
    "<!-- HOLD -->",
    "- ```\n  HOLD: example\n  ```",
    "1. ```\n   HOLD: example\n   ```\n2. next",
    "> ```\n> HOLD: quoted example\n> ```",
    "- item\n\n  ```\n  HOLD: example\n  ```",
    "Example:\n\n    HOLD: in an indented code block",
  ])("does not read %j as a hold", (body) => {
    expect(
      pullRequestHoldReason({ ...open, body, labels: [{ name: "holdout-tests" }] }),
    ).toBeNull();
  });
});

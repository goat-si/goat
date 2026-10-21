import type { DecisionItem } from "@goat/client-runtime/state/decision-inbox";
import type { PendingUserInputDraftAnswer } from "@goat/client-runtime/state/user-input-draft";
import { EnvironmentId, RuntimeRequestId, ThreadId } from "@goat/contracts";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { DecisionUserInputForm } from "./DecisionUserInputForm";

type InputItem = Extract<DecisionItem, { kind: "user_input" }>;
const questionItem: InputItem = {
  id: "test-input",
  ref: { environmentId: EnvironmentId.make("test-env"), threadId: ThreadId.make("test-thread") },
  kind: "user_input",
  createdAt: "2026-10-01T00:00:00.000Z",
  request: {
    requestId: RuntimeRequestId.make("test-request"),
    createdAt: "2026-10-01T00:00:00.000Z",
    responseCapability: "live",
    dismissible: false,
    questions: [
      {
        id: "approach",
        header: "Approach",
        question: "Choose an approach",
        multiSelect: false,
        allowCustomAnswer: false,
        options: [
          { label: "Incremental", value: " provider-id ", description: "One module at a time" },
        ],
      },
      {
        id: "targets",
        header: "Targets",
        question: "Which targets?",
        multiSelect: true,
        options: [
          { label: "Web", value: "web-id", description: "Browser" },
          { label: "Desktop", value: "desktop-id", description: "Desktop app" },
        ],
      },
    ],
  },
};
const onSubmit = vi.fn<(answers: Record<string, string | string[]>) => Promise<void>>();
let root: Root;
let container: HTMLDivElement;
const emptyDrafts: Record<string, PendingUserInputDraftAnswer> = {};
function Harness({
  item = questionItem,
  disabled = false,
  initial = emptyDrafts,
}: {
  item?: InputItem;
  disabled?: boolean;
  initial?: Record<string, PendingUserInputDraftAnswer>;
}) {
  const [drafts, setDrafts] = useState(initial);
  return (
    <DecisionUserInputForm
      item={item}
      drafts={drafts}
      disabled={disabled}
      onChange={setDrafts}
      onSubmit={onSubmit}
    />
  );
}
async function render(
  item = questionItem,
  disabled = false,
  initial: Record<string, PendingUserInputDraftAnswer> = {},
) {
  await act(async () => root.render(<Harness item={item} disabled={disabled} initial={initial} />));
}
function button(label: string) {
  const result = [...container.querySelectorAll("button")].find((entry) =>
    entry.textContent?.trim().startsWith(label),
  );
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function submit() {
  const form = container.querySelector("form");
  if (!form) throw new Error("Missing answer form");
  await act(async () =>
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}
async function typeAnswer(value: string) {
  const field = container.querySelector("textarea");
  if (!field) throw new Error("Missing custom answer");
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (!setter) throw new Error("Missing native textarea setter");
  await act(async () => {
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onSubmit.mockReset().mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("guides empty-question requests back to the thread without sending empty answers", async () => {
  await render({ ...questionItem, request: { ...questionItem.request, questions: [] } });
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    "This request has no questions. Open the thread to continue.",
  );
  expect(container.querySelector("form")).toBeNull();
  expect(container.querySelector("button")).toBeNull();
  expect(onSubmit).not.toHaveBeenCalled();
});

it("requires every answer, preserves provider values, and submits selected arrays explicitly", async () => {
  await render();
  expect(button("Submit answer").disabled).toBe(true);
  expect(container.querySelectorAll("textarea")).toHaveLength(1);
  expect(container.querySelector("kbd")).toBeNull();
  await submit();
  expect(onSubmit).not.toHaveBeenCalled();
  await click("Incremental");
  expect(button("Submit answer").disabled).toBe(true);
  await click("Web");
  await click("Desktop");
  expect(button("Submit answer").disabled).toBe(false);
  expect(onSubmit).not.toHaveBeenCalled();
  await submit();
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
    approach: " provider-id ",
    targets: ["web-id", "desktop-id"],
  });
});

it("custom text replaces selections, and selecting again replaces the custom text", async () => {
  await render();
  await click("Incremental");
  await click("Web");
  await click("Desktop");
  await typeAnswer("  Ship native first  ");
  await submit();
  expect(onSubmit).toHaveBeenLastCalledWith({
    approach: " provider-id ",
    targets: "Ship native first",
  });
  await click("Web");
  expect(container.querySelector("textarea")?.value).toBe("");
  await submit();
  expect(onSubmit).toHaveBeenLastCalledWith({ approach: " provider-id ", targets: ["web-id"] });
});

it("shows which options are selected and clears that state for a custom answer", async () => {
  const choiceItem: InputItem = {
    ...questionItem,
    request: {
      ...questionItem.request,
      questions: [
        {
          id: "merge",
          header: "Question",
          question: "Verify on the simulator first?",
          multiSelect: false,
          options: [
            { label: "Verify first", description: "Check on the simulator" },
            { label: "Merge on unit tests", description: "Skip the simulator" },
          ],
        },
      ],
    },
  };
  await render(choiceItem);
  const pressed = () =>
    [...container.querySelectorAll('button[aria-pressed="true"]')].map((entry) =>
      entry.textContent?.trim(),
    );
  expect(button("Verify first").getAttribute("aria-pressed")).toBe("false");
  expect(container.querySelector("label")?.textContent).toBe("Or write your own answer");
  await click("Verify first");
  expect(pressed()).toEqual([expect.stringMatching(/^Verify first/)]);
  await click("Merge on unit tests");
  expect(pressed()).toEqual([expect.stringMatching(/^Merge on unit tests/)]);
  await typeAnswer("Wait for CI");
  expect(pressed()).toEqual([]);
  await submit();
  expect(onSubmit).toHaveBeenLastCalledWith({ merge: "Wait for CI" });
});

it("seeds initial-answer bytes once and preserves whitespace-only provider answers", async () => {
  const initialItem: InputItem = {
    ...questionItem,
    request: {
      ...questionItem.request,
      questions: [
        {
          id: "initial",
          header: "Initial",
          question: "Confirm the answer",
          options: [],
          multiSelect: false,
          initialAnswer: " \n ",
        },
      ],
    },
  };
  await render(initialItem);
  expect(container.querySelector("textarea")?.value).toBe(" \n ");
  expect(button("Submit answer").disabled).toBe(false);
  await submit();
  expect(onSubmit).toHaveBeenLastCalledWith({ initial: " \n " });
  await typeAnswer("  Edited answer  ");
  await render(initialItem);
  expect(container.querySelector("textarea")?.value).toBe("  Edited answer  ");
  await submit();
  expect(onSubmit).toHaveBeenLastCalledWith({ initial: "  Edited answer  " });
});

it("rejects invalid provider selections and forbidden custom drafts", async () => {
  await render(questionItem, false, {
    approach: { customAnswer: "Forbidden", selectedOptionValues: ["unknown"] },
    targets: { selectedOptionValues: ["web-id"] },
  });
  expect(button("Submit answer").disabled).toBe(true);
  await submit();
  expect(onSubmit).not.toHaveBeenCalled();
  await click("Incremental");
  await submit();
  expect(onSubmit).toHaveBeenLastCalledWith({ approach: " provider-id ", targets: ["web-id"] });
});

it("blocks native controls and form submission while responses are disabled", async () => {
  await render(questionItem, true, {
    approach: { selectedOptionValues: [" provider-id "] },
    targets: { customAnswer: "Ready" },
  });
  await click("Incremental");
  await submit();
  expect([...container.querySelectorAll("button")].every((entry) => entry.disabled)).toBe(true);
  expect(container.querySelector("textarea")?.disabled).toBe(true);
  expect(onSubmit).not.toHaveBeenCalled();
});

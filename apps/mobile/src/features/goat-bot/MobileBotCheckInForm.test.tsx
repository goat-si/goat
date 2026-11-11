import React, { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children, accessibilityRole }: { children?: ReactNode; accessibilityRole?: string }) => (
    <span role={accessibilityRole}>{children}</span>
  ),
  Pressable: ({
    children,
    onPress,
    disabled,
    accessibilityState,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    accessibilityState?: { selected?: boolean };
    accessibilityLabel?: string;
  }) => (
    <button
      onClick={onPress}
      disabled={disabled}
      aria-pressed={accessibilityState?.selected}
      aria-label={accessibilityLabel}
    >
      {children}
    </button>
  ),
}));
vi.mock("@expo/ui/community/datetime-picker", () => ({ DateTimePicker: () => null }));
const state = vi.hoisted(() => ({ upsert: vi.fn() }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("../../state/entities", () => ({
  useThreadShell: () => ({
    id: "bot",
    projectId: "bot-project",
    modelSelection: { instanceId: "codex", model: "gpt-5" },
  }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    upsertScheduledTask: { label: "upsert", permissionAtom: () => "permission", run: state.upsert },
  },
}));
import { MobileBotCheckInForm } from "./MobileBotCheckInForm";
import { MOBILE_CHECK_IN_DRAFT } from "./mobileCheckInDraft";

const container = document.createElement("div");
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container.remove();
});

async function show(tasks: { id: string; title: string; threadId: string | null }[]) {
  document.body.append(container);
  root ??= createRoot(container);
  await act(async () => root?.render(<CheckInForm tasks={tasks} />));
}

// The Home list owns the draft; this holds it the same way.
function CheckInForm(props: { tasks: { id: string; title: string; threadId: string | null }[] }) {
  const [draft, setDraft] = React.useState(MOBILE_CHECK_IN_DRAFT);
  return (
    <MobileBotCheckInForm
      environmentId={"env" as never}
      botThreadId={"bot" as never}
      tasks={props.tasks as never}
      draft={draft}
      onDraftChange={setDraft}
    />
  );
}

const button = (name: string) =>
  [...container.querySelectorAll("button")].find((element) => element.textContent === name);

async function press(name: string) {
  const target = button(name);
  expect(target).toBeDefined();
  await act(async () => target?.click());
}

it("saves a check-in on the chosen days in the bot's chat, then stops offering it", async () => {
  state.upsert.mockReset();
  state.upsert.mockResolvedValue(AsyncResult.success({ task: {} }));
  await show([]);
  await press("Check in on me");
  await press("Sat");
  await press("Mon");
  await press("Save");
  expect(state.upsert).toHaveBeenCalledWith(expect.anything(), {
    environmentId: "env",
    input: expect.objectContaining({
      title: "Check in",
      threadId: "bot",
      notificationPolicy: "important_updates",
      schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [2, 3, 4, 5, 6] },
      creationSource: "mobile",
    }),
  });
  expect(button("Save")).toBeUndefined();
  await show([{ id: "goat-bot-check-in:bot", title: "Morning look", threadId: "bot" }]);
  expect(button("Check in on me")).toBeUndefined();
});

it("a refused save keeps the form open and shows why", async () => {
  state.upsert.mockReset();
  state.upsert.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("Denied"))));
  await show([]);
  await press("Check in on me");
  await press("Save");
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Couldn't save the check-in: Denied",
  );
  expect(button("Save")).toBeDefined();
});

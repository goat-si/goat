import type { DecisionItem } from "@goat/client-runtime/state/decision-inbox";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  AppTextInput: (props: { accessibilityLabel?: string; value?: string }) => (
    <input aria-label={props.accessibilityLabel} value={props.value} readOnly />
  ),
}));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; disabled?: boolean; onPress?: () => void }) => (
    <button type="button" disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));

import { DecisionDurableCard } from "./DecisionDurableCard";

const createdAt = "2026-10-01T00:00:00.000Z";
function decision(recommended: string | null): Extract<DecisionItem, { kind: "decision" }> {
  const ref = { environmentId: EnvironmentId.make("A"), threadId: ThreadId.make("thread") };
  return {
    id: "decision-row",
    ref,
    routing: { routedTo: "person" },
    kind: "decision",
    createdAt,
    decision: {
      id: "decision:1",
      source: "decision",
      from: { threadId: ref.threadId },
      title: "Which database?",
      context: "",
      options: [
        { id: "sqlite", label: "SQLite", consequence: "No new server" },
        { id: "pg", label: "Postgres", consequence: "Needs a server" },
      ],
      recommended,
      requiredProfile: "default",
      expiresAt: null,
      status: "open",
      answer: null,
      answeredBy: null,
      createdAt,
      updatedAt: createdAt,
      humanRequired: false,
    },
  };
}

async function renderCard(recommended: string | null) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const onSubmit = vi.fn();
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(() =>
    root.render(
      <DecisionDurableCard
        item={decision(recommended)}
        draft={undefined}
        disabled={false}
        responding={false}
        onChange={() => {}}
        onSubmit={onSubmit}
      />,
    ),
  );
  const submit = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Submit decision",
  )!;
  return { onSubmit, submit, [Symbol.asyncDispose]: () => act(() => root.unmount()) };
}

it("submits the recommended option without a typed reason", async () => {
  await using card = await renderCard("sqlite");
  expect(card.submit.disabled).toBe(false);
  await act(() => card.submit.click());
  expect(card.onSubmit).toHaveBeenCalledExactlyOnceWith("sqlite", "");
});

it("waits for a choice when nothing is recommended", async () => {
  await using card = await renderCard(null);
  expect(card.submit.disabled).toBe(true);
});

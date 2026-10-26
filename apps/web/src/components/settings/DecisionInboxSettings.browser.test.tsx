import { RegistryContext } from "@effect/atom-react";
import { type DecisionItem, EnvironmentId, RuntimeRequestId, ThreadId } from "@goat/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "../../index.css";

const state = vi.hoisted(() => ({
  query: vi.fn(),
  permission: vi.fn(),
  run: vi.fn(),
  read: vi.fn(),
  scope: vi.fn(),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    decisionItems: state.query,
    answerDecision: { label: "decision:answer", run: state.run, permissionAtom: state.permission },
    getDecision: { label: "decision:get", run: state.read, permissionAtom: state.permission },
  },
}));
vi.mock("./SettingsScopeContext", () => ({ useSettingsScope: state.scope }));
// Keep the live query and command hooks; the page shell otherwise imports unrelated settings state.
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  SettingsSection: ({
    title,
    children,
    headerAction,
  }: {
    title: string;
    children: ReactNode;
    headerAction: ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      {headerAction}
      {children}
    </section>
  ),
}));

import { DecisionInboxSettings } from "./DecisionInboxSettings";

const environmentId = EnvironmentId.make("decision-environment");
const decision: DecisionItem = {
  id: "decision-1",
  source: "decision",
  from: {},
  title: "Choose a release strategy",
  context: "The migration can ship independently.",
  options: [{ id: "staged", label: "Stage rollout", consequence: "Release to one host first." }],
  recommended: "staged",
  requiredProfile: "maintainer",
  expiresAt: null,
  status: "open",
  answer: null,
  answeredBy: null,
  createdAt: "2026-10-21T10:00:00.000Z",
  updatedAt: "2026-10-21T10:00:00.000Z",
  humanRequired: true,
};

function setup(
  item = decision,
  initialItems = [item],
  metadata = {
    unavailableHosts: [] as { host: string; code: string; message: string }[],
    truncated: false,
  },
) {
  const registry = AtomRegistry.make();
  const items = Atom.make(AsyncResult.success({ items: initialItems, ...metadata }));
  const allowed = Atom.make(true);
  const allItems = Atom.make((get) => get(items));
  const openItems = Atom.make((get) =>
    AsyncResult.success({
      ...get(items).value,
      items: get(items).value.items.filter((entry) => entry.status === "open"),
    }),
  );
  state.query
    .mockReset()
    .mockImplementation((target: { input: { status?: string } }) =>
      target.input.status === "open" ? openItems : allItems,
    );
  state.permission.mockReset().mockReturnValue(allowed);
  state.scope
    .mockReset()
    .mockReturnValue({ connectedEnvironments: [{ environmentId, label: "Release host" }] });
  state.read.mockReset().mockResolvedValue({ _tag: "Success", value: item });
  state.run.mockReset().mockImplementation(async () => {
    const answered = {
      ...item,
      status: "answered" as const,
      answer: "staged",
      answeredBy: "You",
    };
    registry.set(items, AsyncResult.success({ items: [answered], ...metadata }));
    return { _tag: "Success", value: answered };
  });
  return { registry, allowed, items, [Symbol.dispose]: () => registry.dispose() };
}

it("keeps an answer editable after failure, then records the chosen option and reason", async () => {
  using fixture = setup();
  state.run.mockImplementationOnce(async () => ({
    _tag: "Failure",
    cause: Cause.fail(new Error("Decision changed; refresh and retry.")),
  }));
  await using screen = await render(
    <RegistryContext value={fixture.registry}>
      <DecisionInboxSettings />
    </RegistryContext>,
  );
  const option = screen.getByRole("button", { name: "Stage rollout (recommended)" });
  await expect.element(option).toBeDisabled();
  await userEvent.fill(
    screen.getByRole("textbox", { name: "Reason for your answer" }),
    "Validate the migration on one host.",
  );
  await userEvent.click(option);
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("Decision changed; refresh and retry.");
  await expect
    .element(screen.getByRole("textbox"))
    .toHaveValue("Validate the migration on one host.");
  await userEvent.click(option);
  await expect.element(screen.getByText("No open decisions.")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Show answered and expired" }));
  await expect.element(screen.getByText("Answered: Stage rollout · You")).toBeVisible();
  expect(state.run.mock.calls.at(-1)?.[1]).toEqual({
    environmentId,
    input: { id: "decision-1", optionId: "staged", reason: "Validate the migration on one host." },
  });
  expect(state.run).toHaveBeenCalledTimes(2);
});

it("answers a projected question using its provider option value", async () => {
  using fixture = setup({
    ...decision,
    id: "pending-1",
    source: "pending_request",
    options: [],
    pending: {
      threadId: ThreadId.make("asking-thread"),
      requestId: RuntimeRequestId.make("request-1"),
      questions: [
        {
          id: "scope",
          header: "Scope",
          question: "Which hosts?",
          options: [{ label: "Canary host", value: "canary", description: "Use one host." }],
        },
      ],
    },
  });
  await using screen = await render(
    <RegistryContext value={fixture.registry}>
      <DecisionInboxSettings />
    </RegistryContext>,
  );
  await userEvent.fill(
    screen.getByRole("textbox", { name: "Reason for your answer" }),
    "Check one host first.",
  );
  await userEvent.click(screen.getByRole("button", { name: "Canary host" }));
  await expect.element(screen.getByText("No open decisions.")).toBeVisible();
  expect(state.run.mock.calls[0]?.[1]).toEqual({
    environmentId,
    input: { id: "pending-1", answers: { scope: "canary" }, reason: "Check one host first." },
  });
});

it("baseline-failing: revalidates and answers on the asking host, preserving the draft when the host refuses", async () => {
  using fixture = setup({ ...decision, from: { host: "build-host" } });
  state.run.mockResolvedValue({
    _tag: "Failure",
    cause: Cause.fail(new Error("The asking host is unavailable.")),
  });
  await using screen = await render(
    <RegistryContext value={fixture.registry}>
      <DecisionInboxSettings />
    </RegistryContext>,
  );
  await userEvent.fill(screen.getByRole("textbox"), "Keep the staged rollout.");
  await userEvent.click(screen.getByRole("button", { name: "Stage rollout (recommended)" }));
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("The asking host is unavailable.");
  await expect.element(screen.getByRole("textbox")).toHaveValue("Keep the staged rollout.");
  expect(state.read.mock.calls[0]?.[1]).toEqual({
    environmentId,
    input: { id: decision.id, host: "build-host" },
  });
  expect(state.run.mock.calls[0]?.[1]).toEqual({
    environmentId,
    input: {
      id: decision.id,
      host: "build-host",
      optionId: "staged",
      reason: "Keep the staged rollout.",
    },
  });
});

it("baseline-failing: keeps same-id drafts attached to their destination when a partial refresh reorders rows", async () => {
  const first = {
    ...decision,
    title: "First destination",
    from: { environmentId: EnvironmentId.make("remote-a"), host: "alpha" },
  };
  const second = {
    ...decision,
    title: "Second destination",
    from: { environmentId: EnvironmentId.make("remote-b"), host: "beta" },
  };
  using fixture = setup(first, [first, second]);
  await using screen = await render(
    <RegistryContext value={fixture.registry}>
      <DecisionInboxSettings />
    </RegistryContext>,
  );
  await userEvent.fill(screen.getByRole("textbox").nth(0), "Alpha draft");
  await userEvent.fill(screen.getByRole("textbox").nth(1), "Beta draft");
  fixture.registry.set(
    fixture.items,
    AsyncResult.success({ items: [second, first], unavailableHosts: [], truncated: false }),
  );
  await expect.element(screen.getByRole("textbox").nth(0)).toHaveValue("Beta draft");
  await expect.element(screen.getByRole("textbox").nth(1)).toHaveValue("Alpha draft");
  expect(screen.getByRole("textbox").nth(0).element().id).not.toBe(
    screen.getByRole("textbox").nth(1).element().id,
  );
});

it("baseline-failing: never opens a remote asking thread in the origin environment", async () => {
  using fixture = setup({
    ...decision,
    from: { host: "build-host", threadId: ThreadId.make("same-thread-id") },
  });
  await using screen = await render(
    <RegistryContext value={fixture.registry}>
      <DecisionInboxSettings />
    </RegistryContext>,
  );
  await expect.element(screen.getByText(decision.title)).toBeVisible();
  await expect
    .element(screen.getByRole("link", { name: "Open asking thread" }))
    .not.toBeInTheDocument();
});

it("baseline-failing: shows unavailable destinations and truncation while keeping available decisions usable", async () => {
  using fixture = setup(decision, [decision], {
    unavailableHosts: [
      { host: "offline-host", code: "unavailable", message: "Update GOAT on offline-host." },
    ],
    truncated: true,
  });
  await using screen = await render(
    <RegistryContext value={fixture.registry}>
      <DecisionInboxSettings />
    </RegistryContext>,
  );
  await expect
    .element(screen.getByText("Update GOAT on offline-host.", { exact: false }))
    .toBeVisible();
  await expect
    .element(screen.getByText("Some decisions are not shown.", { exact: false }))
    .toBeVisible();
  await userEvent.fill(screen.getByRole("textbox"), "Available destination still works.");
  await expect
    .element(screen.getByRole("button", { name: "Stage rollout (recommended)" }))
    .toBeEnabled();
});

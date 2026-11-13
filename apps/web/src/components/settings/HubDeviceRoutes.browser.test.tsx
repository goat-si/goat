import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, type HubDeviceRoutesResult } from "@goat/contracts";
import * as Cause from "effect/Cause";
import { AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "../../index.css";

const state = vi.hoisted(() => ({ list: vi.fn(), update: vi.fn() }));
vi.mock("~/state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  const allowed = () => Atom.make(true);
  return {
    serverEnvironment: {
      listHubDeviceRoutes: { label: "hub:routes", run: state.list, permissionAtom: allowed },
      updateHubDeviceRoutes: {
        label: "hub:routes-update",
        run: state.update,
        permissionAtom: allowed,
      },
    },
  };
});

import { HubDeviceRoutes } from "./HubDeviceRoutes";

const listed = (routes: ReadonlyArray<string>) => ({
  _tag: "Success" as const,
  value: {
    deviceAlias: "mini",
    state: "ok",
    message: `mini has ${routes.length} route(s).`,
    linkId: "lnk_0123456789abcdef",
    pin: "mini",
    routes,
  } satisfies HubDeviceRoutesResult,
});

const stored = {
  _tag: "Success" as const,
  value: {
    deviceAlias: "mini",
    state: "ok",
    code: "routes_stored_reload_failed",
    message:
      "The change was stored, but the Home could not apply it yet; it applies once OpenCodex restarts there.",
    linkId: "lnk_0123456789abcdef",
  } satisfies HubDeviceRoutesResult,
};

/** Opens the routes, adds mini-lan, and lets the read-back after the stored change answer `readBack`. */
async function addStored(readBack: unknown) {
  state.list.mockReset().mockResolvedValueOnce(listed(["mini", "pen-mini"]));
  state.update.mockReset().mockResolvedValueOnce(stored);
  await using stack = new AsyncDisposableStack();
  const registry = AtomRegistry.make();
  stack.defer(() => registry.dispose());
  const screen = stack.use(
    await render(
      <RegistryContext value={registry}>
        <HubDeviceRoutes
          environmentId={EnvironmentId.make("hub")}
          alias="mini"
          direction="hub-initiated"
        />
      </RegistryContext>,
    ),
  );
  await userEvent.click(screen.getByRole("button", { name: "Routes" }));
  await expect.element(screen.getByText("pen-mini")).toBeVisible();
  state.list.mockResolvedValueOnce(readBack);
  await userEvent.fill(screen.getByRole("textbox", { name: "New route for mini" }), "mini-lan");
  await userEvent.click(screen.getByRole("button", { name: "Add route" }));
  const opened = stack.move();
  return { screen, [Symbol.asyncDispose]: () => opened.disposeAsync() };
}

it("a change the Home stored but could not apply keeps saying so after the list is read back", async () => {
  await using opened = await addStored(listed(["mini-lan", "mini", "pen-mini"]));
  const { screen } = opened;
  await expect.element(screen.getByText("mini-lan")).toBeVisible();
  await expect
    .element(screen.getByRole("status"))
    .toHaveTextContent(
      "The change was stored, but the Home could not apply it yet; it applies once OpenCodex restarts there.",
    );
});

it("a read-back that fails after a stored change shows its error beside the stored notice", async () => {
  await using opened = await addStored({
    _tag: "Failure",
    cause: Cause.fail(new Error("connection lost")),
  });
  const { screen } = opened;
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("Could not read the routes again: connection lost");
  await expect.element(screen.getByText("pen-mini")).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("status"))
    .toHaveTextContent(
      "The change was stored, but the Home could not apply it yet; it applies once OpenCodex restarts there.",
    );
});

it("a read-back the Home answers as failed shows its error, and no longer shows the old list as current", async () => {
  await using opened = await addStored({
    _tag: "Success",
    value: {
      deviceAlias: "mini",
      state: "failed",
      message: "ocx link routes exited 1 on this Home.",
    } satisfies HubDeviceRoutesResult,
  });
  const { screen } = opened;
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("Could not read the routes again: ocx link routes exited 1 on this Home.");
  await expect.element(screen.getByText("pen-mini")).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("status"))
    .toHaveTextContent(
      "The change was stored, but the Home could not apply it yet; it applies once OpenCodex restarts there.",
    );
});

it("offers no Routes for a link the Child opened, since the Home has none to change", async () => {
  const registry = AtomRegistry.make();
  await using screen = await render(
    <RegistryContext value={registry}>
      <HubDeviceRoutes
        environmentId={EnvironmentId.make("hub")}
        alias="mini"
        direction="client-initiated"
      />
    </RegistryContext>,
  );
  await expect.element(screen.getByRole("button", { name: "Routes" })).not.toBeInTheDocument();
  registry.dispose();
});
it("a change from a session that cannot answer decisions waits for one, and Continue runs that change with it", async () => {
  state.list.mockReset().mockResolvedValue(listed(["mini"]));
  state.update
    .mockReset()
    .mockResolvedValueOnce({
      _tag: "Success",
      value: {
        deviceAlias: "mini",
        state: "needs_human",
        message: "Changing a Child's routes needs an owner's approval.",
        linkId: "lnk_0123456789abcdef",
        decisionId: "decision-1",
      } satisfies HubDeviceRoutesResult,
    })
    .mockResolvedValueOnce(listed(["mini-lan", "mini"]));
  const registry = AtomRegistry.make();
  await using screen = await render(
    <RegistryContext value={registry}>
      <HubDeviceRoutes
        environmentId={EnvironmentId.make("hub")}
        alias="mini"
        direction="hub-initiated"
      />
    </RegistryContext>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Routes" }));
  await userEvent.fill(screen.getByRole("textbox", { name: "New route for mini" }), "mini-lan");
  await userEvent.click(screen.getByRole("button", { name: "Add route" }));
  await expect
    .element(screen.getByRole("link", { name: "Open decision" }))
    .toHaveAttribute("href", "/settings/decision-inbox");
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  await expect.element(screen.getByText("mini-lan")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Continue" })).not.toBeInTheDocument();
  const change = { op: "add", route: "mini-lan" };
  expect(state.update.mock.calls.map((call) => call[1].input)).toEqual([
    { deviceAlias: "mini", change },
    { deviceAlias: "mini", change, decisionId: "decision-1" },
  ]);
  registry.dispose();
});
it("a change waiting for a decision survives leaving the page; Continue reads the list, and before the approval keeps it waiting", async () => {
  state.list.mockReset().mockResolvedValue(listed(["mini"]));
  state.update
    .mockReset()
    .mockResolvedValueOnce({
      _tag: "Success",
      value: {
        deviceAlias: "mini",
        state: "needs_human",
        message: "Changing a Child's routes needs an owner's approval.",
        linkId: "lnk_0123456789abcdef",
        decisionId: "decision-1",
      } satisfies HubDeviceRoutesResult,
    })
    .mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(new Error("The decision is not answered yet.")),
    })
    .mockResolvedValueOnce(listed(["mini-lan", "mini"]));
  const registry = AtomRegistry.make();
  const routes = () => (
    <RegistryContext value={registry}>
      <HubDeviceRoutes
        environmentId={EnvironmentId.make("hub")}
        alias="mini"
        direction="hub-initiated"
      />
    </RegistryContext>
  );
  {
    await using first = await render(routes());
    await userEvent.click(first.getByRole("button", { name: "Routes" }));
    await userEvent.fill(first.getByRole("textbox", { name: "New route for mini" }), "mini-lan");
    await userEvent.click(first.getByRole("button", { name: "Add route" }));
    await expect.element(first.getByRole("button", { name: "Continue" })).toBeVisible();
  }
  await using screen = await render(routes());
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("The decision is not answered yet.");
  await expect.element(screen.getByText("pinned")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  await expect.element(screen.getByText("mini-lan")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Continue" })).not.toBeInTheDocument();
  const change = { op: "add", route: "mini-lan" };
  expect(state.update.mock.calls.map((call) => call[1].input)).toEqual([
    { deviceAlias: "mini", change },
    { deviceAlias: "mini", change, decisionId: "decision-1" },
    { deviceAlias: "mini", change, decisionId: "decision-1" },
  ]);
  registry.dispose();
});

it("a waiting change that can no longer be continued can be discarded, and stays gone", async () => {
  state.list.mockReset().mockResolvedValue(listed(["mini"]));
  state.update.mockReset().mockResolvedValueOnce({
    _tag: "Success",
    value: {
      deviceAlias: "mini",
      state: "needs_human",
      message: "Changing a Child's routes needs an owner's approval.",
      linkId: "lnk_0123456789abcdef",
      decisionId: "decision-1",
    } satisfies HubDeviceRoutesResult,
  });
  const registry = AtomRegistry.make();
  const routes = () => (
    <RegistryContext value={registry}>
      <HubDeviceRoutes
        environmentId={EnvironmentId.make("hub")}
        alias="mini"
        direction="hub-initiated"
      />
    </RegistryContext>
  );
  {
    await using first = await render(routes());
    await userEvent.click(first.getByRole("button", { name: "Routes" }));
    await userEvent.fill(first.getByRole("textbox", { name: "New route for mini" }), "mini-lan");
    await userEvent.click(first.getByRole("button", { name: "Add route" }));
    await expect.element(first.getByRole("button", { name: "Continue" })).toBeVisible();
  }
  {
    await using second = await render(routes());
    await userEvent.click(second.getByRole("button", { name: "Discard" }));
    await expect.element(second.getByRole("button", { name: "Continue" })).not.toBeInTheDocument();
  }
  await using screen = await render(routes());
  await expect.element(screen.getByRole("button", { name: "Routes" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Continue" })).not.toBeInTheDocument();
  expect(state.update).toHaveBeenCalledTimes(1);
  registry.dispose();
});
it("while a change waits for a decision, other edits are off and the row says why; Discard says the decision stays open", async () => {
  state.list.mockReset().mockResolvedValue(listed(["mini", "pen-mini"]));
  state.update.mockReset().mockResolvedValueOnce({
    _tag: "Success",
    value: {
      deviceAlias: "mini",
      state: "needs_human",
      message: "Changing a Child's routes needs an owner's approval.",
      linkId: "lnk_0123456789abcdef",
      decisionId: "decision-1",
    } satisfies HubDeviceRoutesResult,
  });
  const registry = AtomRegistry.make();
  await using screen = await render(
    <RegistryContext value={registry}>
      <HubDeviceRoutes
        environmentId={EnvironmentId.make("hub")}
        alias="mini"
        direction="hub-initiated"
      />
    </RegistryContext>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Routes" }));
  await userEvent.fill(screen.getByRole("textbox", { name: "New route for mini" }), "mini-lan");
  await userEvent.click(screen.getByRole("button", { name: "Add route" }));
  await expect.element(screen.getByRole("button", { name: "Continue" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Remove pen-mini" })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Move pen-mini up" })).toBeDisabled();
  await expect.element(screen.getByRole("textbox", { name: "New route for mini" })).toBeDisabled();
  await expect
    .element(screen.getByText(/Other edits wait until it is continued or discarded/))
    .toBeVisible();
  await expect
    .element(screen.getByText(/Discard forgets it here; the decision stays in the inbox/))
    .toBeVisible();
  registry.dispose();
});

it("a continued change that fails without a refusal code settles the waiting change; one with a refusal code keeps it", async () => {
  state.list.mockReset().mockResolvedValue(listed(["mini"]));
  state.update
    .mockReset()
    .mockResolvedValueOnce({
      _tag: "Success",
      value: {
        deviceAlias: "mini",
        state: "needs_human",
        message: "Changing a Child's routes needs an owner's approval.",
        linkId: "lnk_0123456789abcdef",
        decisionId: "decision-1",
      } satisfies HubDeviceRoutesResult,
    })
    .mockResolvedValueOnce({
      _tag: "Success",
      value: {
        deviceAlias: "mini",
        state: "failed",
        code: "route_unproven",
        message: "The Home could not prove the link's pinned host key over that route (hostkey).",
        linkId: "lnk_0123456789abcdef",
      } satisfies HubDeviceRoutesResult,
    })
    .mockResolvedValueOnce({
      _tag: "Success",
      value: {
        deviceAlias: "mini",
        state: "failed",
        message:
          "ocx stopped before it answered. The Home may still finish the change, so read the routes again before you retry it.",
        linkId: "lnk_0123456789abcdef",
      } satisfies HubDeviceRoutesResult,
    });
  const registry = AtomRegistry.make();
  await using screen = await render(
    <RegistryContext value={registry}>
      <HubDeviceRoutes
        environmentId={EnvironmentId.make("hub")}
        alias="mini"
        direction="hub-initiated"
      />
    </RegistryContext>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Routes" }));
  await userEvent.fill(screen.getByRole("textbox", { name: "New route for mini" }), "mini-lan");
  await userEvent.click(screen.getByRole("button", { name: "Add route" }));
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent(
      "The Home could not prove the link's pinned host key over that route (hostkey).",
    );
  await expect.element(screen.getByRole("button", { name: "Continue" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent(
      "ocx stopped before it answered. The Home may still finish the change, so read the routes again before you retry it.",
    );
  await expect.element(screen.getByRole("button", { name: "Continue" })).not.toBeInTheDocument();
  await expect.element(screen.getByRole("textbox", { name: "New route for mini" })).toBeEnabled();
  registry.dispose();
});
it("a continued change whose ocx could not be started keeps the waiting change, and the same decision runs it later", async () => {
  state.list.mockReset().mockResolvedValue(listed(["mini"]));
  state.update
    .mockReset()
    .mockResolvedValueOnce({
      _tag: "Success",
      value: {
        deviceAlias: "mini",
        state: "needs_human",
        message: "Changing a Child's routes needs an owner's approval.",
        linkId: "lnk_0123456789abcdef",
        decisionId: "decision-1",
      } satisfies HubDeviceRoutesResult,
    })
    .mockResolvedValueOnce({
      _tag: "Success",
      value: {
        deviceAlias: "mini",
        state: "failed",
        code: "ocx_unstartable",
        message: "ocx could not be started on this hub, so nothing changed.",
        linkId: "lnk_0123456789abcdef",
      } satisfies HubDeviceRoutesResult,
    })
    .mockResolvedValueOnce(listed(["mini-lan", "mini"]));
  const registry = AtomRegistry.make();
  await using screen = await render(
    <RegistryContext value={registry}>
      <HubDeviceRoutes
        environmentId={EnvironmentId.make("hub")}
        alias="mini"
        direction="hub-initiated"
      />
    </RegistryContext>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Routes" }));
  await userEvent.fill(screen.getByRole("textbox", { name: "New route for mini" }), "mini-lan");
  await userEvent.click(screen.getByRole("button", { name: "Add route" }));
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("ocx could not be started on this hub, so nothing changed.");
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  await expect.element(screen.getByText("mini-lan")).toBeVisible();
  const change = { op: "add", route: "mini-lan" };
  expect(state.update.mock.calls.map((call) => call[1].input)).toEqual([
    { deviceAlias: "mini", change },
    { deviceAlias: "mini", change, decisionId: "decision-1" },
    { deviceAlias: "mini", change, decisionId: "decision-1" },
  ]);
  registry.dispose();
});

it("an answer to an earlier edit that arrives after another change started waiting leaves that waiting change", async () => {
  state.list.mockReset().mockResolvedValue(listed(["mini", "pen-mini"]));
  type Answer = { _tag: "Success"; value: HubDeviceRoutesResult };
  let answerRemoval: (answer: Answer) => void = () => {};
  const removal = new Promise<Answer>((resolve) => {
    answerRemoval = resolve;
  });
  state.update
    .mockReset()
    .mockReturnValueOnce(removal)
    .mockResolvedValueOnce({
      _tag: "Success",
      value: {
        deviceAlias: "mini",
        state: "needs_human",
        message: "Changing a Child's routes needs an owner's approval.",
        linkId: "lnk_0123456789abcdef",
        decisionId: "decision-1",
      } satisfies HubDeviceRoutesResult,
    });
  const registry = AtomRegistry.make();
  const routes = () => (
    <RegistryContext value={registry}>
      <HubDeviceRoutes
        environmentId={EnvironmentId.make("hub")}
        alias="mini"
        direction="hub-initiated"
      />
    </RegistryContext>
  );
  {
    await using first = await render(routes());
    await userEvent.click(first.getByRole("button", { name: "Routes" }));
    await userEvent.click(first.getByRole("button", { name: "Remove pen-mini" }));
    await expect.element(first.getByRole("button", { name: "Working…" })).toBeVisible();
  }
  await using screen = await render(routes());
  await userEvent.click(screen.getByRole("button", { name: "Routes" }));
  await userEvent.fill(screen.getByRole("textbox", { name: "New route for mini" }), "mini-lan");
  await userEvent.click(screen.getByRole("button", { name: "Add route" }));
  await expect.element(screen.getByRole("button", { name: "Continue" })).toBeVisible();
  answerRemoval({
    _tag: "Success",
    value: {
      deviceAlias: "mini",
      state: "ok",
      code: "routes_stored_reload_failed",
      message:
        "The change was stored, but the Home could not apply it yet; it applies once OpenCodex restarts there.",
      linkId: "lnk_0123456789abcdef",
    },
  });
  // The stale instance reads the list back once its answer is handled.
  await expect.poll(() => state.list.mock.calls.length).toBe(3);
  await expect.element(screen.getByRole("button", { name: "Continue" })).toBeVisible();
  registry.dispose();
});

import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ThreadId, type RemoteLaunch } from "@goat/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { useThreadShells } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { RemoteLaunchesSettings } from "./RemoteLaunchesSettings";

const state = vi.hoisted(() => ({
  dismiss: vi.fn(),
  toast: vi.fn(),
}));
vi.mock(import("@tanstack/react-router"), { spy: true });
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.dismiss }));
vi.mock(import("../../state/entities"), { spy: true });
vi.mock(import("../../state/environments"), { spy: true });
vi.mock("../ui/toast", () => ({ toastManager: { add: state.toast } }));

const dispatcher = EnvironmentId.make("dispatcher");
const threadId = ThreadId.make("remote-thread");
const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const unreachable: RemoteLaunch = {
  host: "mini",
  threadId,
  title: "Long build",
  launcherThreadId: ThreadId.make("launcher"),
  source: "thread",
  state: "running",
  latest: null,
  hostUnavailableSince: "2026-11-09T12:00:00.000Z",
  updatedAt: "2026-11-08T12:55:00.000Z",
  dismissable: true,
  dismissedAt: null,
};

function setup() {
  state.dismiss.mockReset();
  state.toast.mockReset();
  const registry = AtomRegistry.make();
  const launches = Atom.make<unknown>(
    AsyncResult.success({ launches: [unreachable], truncated: false }),
  );
  vi.mocked(useThreadShells).mockReturnValue([]);
  vi.mocked(useEnvironments).mockReturnValue({
    environments: [
      {
        environmentId: dispatcher,
        label: "Laptop",
        connection: { phase: "connected" },
        serverConfig: null,
      },
    ],
  } as never);
  vi.spyOn(environmentPresentations, "presentationsAtom", "get").mockReturnValue(
    Atom.make(new Map([[dispatcher, { connection: { phase: "connected" } }]])) as never,
  );
  vi.spyOn(serverEnvironment, "remoteLaunches").mockReturnValue(launches as never);
  vi.spyOn(serverEnvironment.dismissRemoteLaunch, "permissionAtom").mockReturnValue(
    Atom.make(true) as never,
  );
  return { registry, launches };
}

it("a launch whose host stopped answering can be dismissed and then shows as dismissed", async () => {
  const { registry, launches } = setup();
  using _now = vi.spyOn(Date, "now").mockReturnValue(NOW);
  // The server answers with the list it now holds: the launch, dismissed.
  state.dismiss.mockImplementation(async () => {
    registry.set(
      launches,
      AsyncResult.success({
        launches: [
          {
            ...unreachable,
            state: "cancelled",
            dismissable: false,
            dismissedAt: "2026-11-12T12:00:00.000Z",
          },
        ],
        truncated: false,
      }),
    );
    return { _tag: "Success", value: { dispatches: 1, watches: 0 } };
  });
  await using screen = await render(
    <RegistryContext value={registry}>
      <RemoteLaunchesSettings />
    </RegistryContext>,
  );
  await userEvent.click(screen.getByRole("button", { name: /Remote launches/ }));
  await expect.element(screen.getByText(/Host unreachable for 3d/)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(state.dismiss).toHaveBeenCalledWith({
    environmentId: dispatcher,
    input: { host: "mini", threadId },
  });
  await expect.element(screen.getByText(/^Dismissed/)).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();
  expect(state.toast).not.toHaveBeenCalled();
});

it("a launch whose host still answers offers no dismissal", async () => {
  const { registry, launches } = setup();
  registry.set(
    launches,
    AsyncResult.success({
      launches: [{ ...unreachable, hostUnavailableSince: null, dismissable: false }],
      truncated: false,
    }),
  );
  await using screen = await render(
    <RegistryContext value={registry}>
      <RemoteLaunchesSettings />
    </RegistryContext>,
  );
  await userEvent.click(screen.getByRole("button", { name: /Remote launches/ }));
  await expect.element(screen.getByText(/^Running/)).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();
});

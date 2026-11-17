import { EnvironmentId, ThreadId } from "@goat/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { readProjects, waitForProject } from "../../state/entities";
import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentShellHasSnapshot } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { DesktopAppActivationCoordinator } from "./DesktopAppActivationCoordinator";

vi.mock(import("../../env"), async (original) => ({ ...(await original()), isElectron: true }));
vi.mock("../../state/environments", { spy: true });
vi.mock("../../state/shell", { spy: true });
vi.mock("../../state/entities", { spy: true });
vi.mock("../../state/use-atom-command", { spy: true });
vi.mock("../../hooks/useHandleNewThread", { spy: true });

const primaryId = EnvironmentId.make("desktop-primary");
const request = {
  version: 1,
  requestId: "request-1",
  type: "open-workspace",
  workspaceRoot: "/Users/me/code/app",
  platform: "darwin",
} as const;

function setup(localEnabled: boolean) {
  let deliver: ((value: typeof request) => void) | null = null;
  const bridge = {
    onRequest: vi.fn((listener: (value: typeof request) => void) => {
      deliver = listener;
      return () => {
        deliver = null;
      };
    }),
    complete: vi.fn(async () => undefined),
    setReady: vi.fn(async () => undefined),
  };
  const previous = window.desktopBridge;
  Object.assign(window, {
    desktopBridge: { appActivation: bridge, getLocalEnvironmentEnabled: () => localEnabled },
  });
  const createProject = vi.fn(async () => ({ _tag: "Success", value: undefined }));
  vi.mocked(useAtomCommand).mockReturnValue(createProject as never);
  vi.mocked(useNewThreadHandler).mockReturnValue(
    vi.fn(async () => ({ threadId: ThreadId.make("thread-1") })) as never,
  );
  vi.mocked(useEnvironmentShellHasSnapshot).mockReturnValue(localEnabled);
  vi.mocked(readProjects).mockReturnValue([]);
  vi.mocked(waitForProject).mockResolvedValue(undefined as never);
  // With Local off the desktop has no backend of its own, so there is no primary environment.
  vi.mocked(usePrimaryEnvironment).mockReturnValue(
    localEnabled
      ? ({
          environmentId: primaryId,
          entry: { target: { _tag: "PrimaryConnectionTarget" } },
          connection: { phase: "connected" },
          serverConfig: { environment: { platform: { os: "darwin" } } },
        } as never)
      : null,
  );
  return {
    bridge,
    createProject,
    deliver: () => deliver?.(request),
    [Symbol.dispose]: () => Object.assign(window, { desktopBridge: previous }),
  };
}

describe("goat <dir> on the desktop", () => {
  it("adds the folder as a project of the desktop's own primary environment", async () => {
    using activation = setup(true);
    // The coordinator renders nothing and never navigates; it only answers the bridge.
    await using _screen = await render(<DesktopAppActivationCoordinator />, { router: false });
    await vi.waitFor(() => expect(activation.bridge.setReady).toHaveBeenCalledWith(true));
    await act(() => activation.deliver());
    await vi.waitFor(() =>
      expect(activation.bridge.complete).toHaveBeenCalledWith(
        expect.objectContaining({ ok: true, requestId: "request-1" }),
      ),
    );
    expect(activation.createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: primaryId,
        input: expect.objectContaining({ workspaceRoot: request.workspaceRoot }),
      }),
    );
  });

  it("takes no request while the desktop's local environment is off", async () => {
    using activation = setup(false);
    // The coordinator renders nothing and never navigates; it only answers the bridge.
    await using _screen = await render(<DesktopAppActivationCoordinator />, { router: false });
    await act(() => undefined);
    expect(activation.bridge.onRequest).not.toHaveBeenCalled();
    expect(activation.bridge.setReady).not.toHaveBeenCalledWith(true);
    expect(activation.createProject).not.toHaveBeenCalled();
  });
});

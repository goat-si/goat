import type { DesktopUpdateState } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render, stubGlobal } from "../../../test/render";
import { ToastProvider } from "../ui/toast";
import { AboutVersionSection } from "./AboutVersionSection";

const available: DesktopUpdateState = {
  installPolicy: "restart-when-idle",
  pendingRestartReason: null,
  pendingUpdate: null,
  recoveryStatus: null,
  enabled: true,
  status: "available",
  channel: "latest",
  currentVersion: "1.2.3",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: "1.2.4",
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

const snapshot = { read: () => available };

vi.mock("../../state/desktopUpdate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/desktopUpdate")>()),
  useDesktopUpdateState: () => snapshot.read(),
}));

it("tells the user why an update download from About failed", async () => {
  const failed: DesktopUpdateState = {
    ...available,
    status: "error",
    errorContext: "download",
    message: "Download failed: net::ERR_CONTENT_LENGTH_MISMATCH",
    canRetry: true,
  };
  using _bridge = stubGlobal("desktopBridge", {
    downloadUpdate: () => Promise.resolve({ accepted: true, completed: false, state: failed }),
  });
  await using screen = await render(
    <ToastProvider>
      <AboutVersionSection />
    </ToastProvider>,
  );

  await screen.getByRole("button", { name: /download/i }).click();

  await expect.element(page.getByText("Could not download update")).toBeVisible();
});

it.each(["download", "install"] as const)(
  "offers the target installer and a stage-specific retry after %s fails",
  async (stage) => {
    using _snapshot = vi.spyOn(snapshot, "read").mockReturnValue({
      ...available,
      status: stage === "install" ? "downloaded" : "available",
      downloadedVersion: stage === "install" ? "1.2.4" : null,
      errorContext: stage,
      message: "Failure detail from the updater.",
      canRetry: true,
    });
    const openExternal = vi.fn(async () => true);
    using _bridge = stubGlobal("desktopBridge", { openExternal });
    await using screen = await render(<AboutVersionSection />);
    await expect
      .element(screen.getByText("Failure detail from the updater.", { exact: true }))
      .toBeVisible();
    await expect
      .element(
        screen.getByRole("button", {
          name: stage === "install" ? "Retry installation" : "Retry download",
        }),
      )
      .toBeVisible();
    const installer = screen.getByRole("link", { name: "Find installer on GitHub" });
    await installer.click();
    expect(openExternal).toHaveBeenCalledWith(
      "https://github.com/goat-si/goat-releases/releases/tag/v1.2.4",
    );
  },
);

it("keeps normal offers free of manual recovery actions", async () => {
  using _bridge = stubGlobal("desktopBridge", {});
  await using screen = await render(<AboutVersionSection />);
  await expect.element(screen.getByRole("button", { name: "Download", exact: true })).toBeVisible();
  expect(screen.getByRole("link", { name: "Find installer on GitHub" }).query()).toBeNull();
});

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

vi.mock("../../state/desktopUpdate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/desktopUpdate")>()),
  useDesktopUpdateState: () => available,
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

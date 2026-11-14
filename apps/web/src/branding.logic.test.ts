import { describe, expect, it } from "vite-plus/test";
import {
  formatAppDisplayName,
  resolveWebAppStageLabel,
  resolveWindowTitle,
} from "./branding.logic";

describe("window title", () => {
  it("uses the current thread and project in web and desktop titles", () => {
    const input = {
      appDisplayName: "GOAT (Nightly)",
      projectTitle: " Project ",
      threadTitle: " Thread ",
    };
    expect(resolveWindowTitle({ ...input, desktop: false })).toBe(
      "Project / Thread - GOAT (Nightly)",
    );
    expect(resolveWindowTitle({ ...input, desktop: true })).toBe("Project / Thread");
    expect(resolveWindowTitle({ ...input, projectTitle: null, desktop: true })).toBe("Thread");
    expect(resolveWindowTitle({ ...input, threadTitle: " ", desktop: false })).toBe(
      "GOAT (Nightly)",
    );
  });
  it("names hosted builds by the channel the release workflow sets, and dev builds Dev", () => {
    const name = (env: Parameters<typeof resolveWebAppStageLabel>[0]) =>
      formatAppDisplayName({ baseName: "GOAT", stageLabel: resolveWebAppStageLabel(env) });
    expect(name({ VITE_HOSTED_APP_CHANNEL: "latest", DEV: false })).toBe("GOAT");
    expect(name({ VITE_HOSTED_APP_CHANNEL: "nightly", DEV: false })).toBe("GOAT (Nightly)");
    expect(name({ VITE_RELEASE_CHANNEL: "dev", DEV: false })).toBe("GOAT (Dev)");
    expect(name({ DEV: true })).toBe("GOAT (Dev)");
    expect(name({ VITE_RELEASE_CHANNEL: "preview", DEV: false })).toBe("GOAT (Beta)");
  });
});

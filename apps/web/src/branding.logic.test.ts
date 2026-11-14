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
  it("labels stable, nightly and development builds consistently", () => {
    const name = (channel: string) =>
      formatAppDisplayName({
        baseName: "GOAT",
        stageLabel: resolveWebAppStageLabel({ hostedAppChannel: channel, development: false }),
      });
    expect(name("stable")).toBe("GOAT");
    expect(name("nightly")).toBe("GOAT (Nightly)");
    expect(name("dev")).toBe("GOAT (Dev)");
  });
});

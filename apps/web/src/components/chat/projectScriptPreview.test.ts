import { EnvironmentId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";

vi.mock("../../browser/previewRuntime", () => ({
  isPreviewAvailableFor: (id: string) => id === "server",
}));
import { shouldAutoOpenProjectPreview } from "./projectScriptPreview";

it("opens enabled project previews on capable server browsers", () => {
  const script = { autoOpenPreview: true, previewUrl: "http://localhost:3000" };
  expect(shouldAutoOpenProjectPreview(script, EnvironmentId.make("server"))).toBe(true);
  expect(shouldAutoOpenProjectPreview(script, EnvironmentId.make("older"))).toBe(false);
  expect(
    shouldAutoOpenProjectPreview(
      { ...script, autoOpenPreview: false },
      EnvironmentId.make("server"),
    ),
  ).toBe(false);
});

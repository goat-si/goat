import type { ReactNode } from "react";
import { act, Profiler } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  Passthrough: ({ children }: { children?: unknown }) => children,
}));
vi.mock("react-native", () => ({ View: harness.Passthrough }));
vi.mock("expo-image", () => ({
  Image: ({ source }: { readonly source: { readonly uri: string } }) => (
    <img alt="" src={source.uri} />
  ),
}));
vi.mock("./ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("./ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../features/settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "dark" }),
}));
vi.mock("../state/assets", async () => {
  const { Atom } = await import("effect/reactivity");
  const url = Atom.make<string | null>("https://example.test/favicon.png");
  const adaptiveSvg =
    '<svg xmlns="http://www.w3.org/2000/svg"><style>@media (prefers-color-scheme: dark) { :root { color: white } }</style><path fill="currentColor"/></svg>';
  const adaptiveUrl = `data:image/svg+xml;base64,${Buffer.from(adaptiveSvg).toString("base64")}`;
  const adaptive = Atom.make<string | null>(adaptiveUrl);
  return {
    projectFaviconUrlAtom: ({ cwd }: { readonly cwd: string }) =>
      cwd === "/adaptive" ? adaptive : url,
  };
});
import { EnvironmentId } from "@goat/contracts";
import { ProjectFavicon } from "./ProjectFavicon";

it("mounts the favicon image in the first commit", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  const commits: string[] = [];
  try {
    await act(async () =>
      root.render(
        <Profiler id="favicon" onRender={(_id, phase) => commits.push(phase)}>
          <ProjectFavicon
            environmentId={EnvironmentId.make("env-1")}
            projectTitle="Project"
            workspaceRoot="/repo"
          />
        </Profiler>,
      ),
    );
    expect(container.querySelector("img")).not.toBeNull();
    expect(commits).toEqual(["mount"]);
  } finally {
    await act(async () => root.unmount());
  }
});

it("loads an inline favicon with the app's dark variant", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ProjectFavicon
          environmentId={EnvironmentId.make("env-1")}
          projectTitle="Adaptive"
          workspaceRoot="/adaptive"
        />,
      ),
    );
    const source = container.querySelector("img")?.getAttribute("src");
    const resolved = Buffer.from(source?.split(",")[1] ?? "", "base64").toString();
    expect(resolved).toContain('<svg color="white"');
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

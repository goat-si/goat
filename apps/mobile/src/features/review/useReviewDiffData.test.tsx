import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ diffFilePatch: vi.fn() }));
vi.mock("../../state/review", () => ({ reviewEnvironment: mocks }));
vi.mock("../pull-requests/usePullRequestFileFilter", async () => {
  const { useState } = await import("react");
  return {
    useHideTestFilesPreference: () => {
      const [hideTestFiles, setHide] = useState(true);
      return {
        hideTestFiles,
        toggle: () => setHide(!hideTestFiles),
        showAll: () => setHide(false),
      };
    },
  };
});
import { useReviewDiffData } from "./useReviewDiffData";
import type { ReviewSectionItem } from "./reviewModel";

it("loads visible lazy patches first and restores test files when the filter is cleared", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const paths = ["a.test.ts", "src/__mocks__/api.ts", "app.ts", "b.ts", "c.ts"];
  const files = paths.map((path) => ({ path, previousPath: null, additions: 1, deletions: 0 }));
  const source = {
    id: "diff",
    kind: "working-tree" as const,
    title: "Changes",
    baseRef: null,
    headRef: null,
    diff: "",
    diffHash: "hash",
    truncated: true,
    files,
  };
  const section: ReviewSectionItem = {
    id: "review",
    kind: "working-tree",
    title: "Changes",
    subtitle: null,
    diff: "",
    isLoading: false,
    source,
  };
  const requests: string[] = [];
  const atoms = Atom.family((_path: string) => Atom.make(Effect.never));
  mocks.diffFilePatch.mockImplementation(
    (request: { input: { request: { file: { path: string } } } }) => {
      const path = request.input.request.file.path;
      requests.push(path);
      return atoms(path);
    },
  );
  const registry = AtomRegistry.make();
  const root = createRoot(document.createElement("div"));
  let current: ReturnType<typeof useReviewDiffData> | undefined;
  function Probe() {
    const result = useReviewDiffData({
      threadKey: "thread",
      environmentId: EnvironmentId.make("env"),
      cwd: "/workspace",
      selectedSection: section,
      draftMessage: "",
      draftContext: undefined,
    });
    useLayoutEffect(() => {
      current = result;
    });
    return null;
  }
  try {
    act(() =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <Probe />
        </RegistryContext.Provider>,
      ),
    );
    if (!current || current.parsedDiff.kind !== "files") throw new Error("Expected files");
    expect(current.parsedDiff.files.map((file) => file.path)).toEqual(["app.ts", "b.ts", "c.ts"]);
    expect(new Set(requests)).toEqual(new Set(["app.ts", "b.ts", "c.ts"]));
    expect(current.allFiles.map((file) => file.path)).toEqual(paths);
    act(() => current?.fileFilter.showAll());
    if (!current || current.parsedDiff.kind !== "files") throw new Error("Expected files");
    expect(current.parsedDiff.files.map((file) => file.path)).toEqual(paths);
    expect(requests).toContain("a.test.ts");
    expect(requests).toContain("src/__mocks__/api.ts");
  } finally {
    act(() => root.unmount());
    registry.dispose();
    vi.unstubAllGlobals();
    mocks.diffFilePatch.mockReset();
  }
});

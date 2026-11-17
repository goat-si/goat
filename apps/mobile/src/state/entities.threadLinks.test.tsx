import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ProjectId, ThreadId } from "@goat/contracts";
import { AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

// Upstream 23e3465ec6 tests its mobile link metadata in entities.test.ts; GOAT answers it through
// the thread family lookup, so these cases read that answer the way entities.ts does.
const state = vi.hoisted(() => ({
  resolution: { checked: new Set<string>(), titles: {}, projectIds: {} } as {
    checked: ReadonlySet<string>;
    titles: Record<string, string>;
    projectIds: Record<string, string | null>;
  },
}));

vi.mock("./threadLinkLookup", () => ({ useThreadLinkLookup: () => state.resolution }));
vi.mock("./threads", async () => {
  const { Atom } = await import("effect/reactivity");
  const noShell = Atom.make(null);
  return {
    environmentThreadDetails: {},
    steadyNavigationThreadShellsAtom: Atom.make([]),
    environmentThreadShells: {
      environmentThreadIndexAtom: () => Atom.make(new Map()),
      threadRefsAtom: Atom.make([]),
      threadShellAtom: () => noShell,
    },
  };
});
vi.mock("./projects", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentProjects: {
      projectAtom: Atom.family((ref: { projectId: string }) =>
        Atom.make({ id: ref.projectId, title: ref.projectId, workspaceRoot: `/${ref.projectId}` }),
      ),
    },
  };
});
vi.mock("../lib/projectIcon", () => ({
  resolveProjectChipIcon: (project: { id: string } | null) =>
    project ? { kind: "favicon", uri: `icon:${project.id}` } : null,
}));
vi.mock("./server", async () => {
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    environmentServerConfigsAtom: Atom.make(new Map()),
    serverEnvironment: { configValueAtom: () => noConfig },
  };
});
vi.mock("./assets", () => ({ projectFaviconUrlAtom: () => null }));
vi.mock("./atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("./appChipIcons", () => ({ useAppChipIcons: () => new Map() }));
vi.mock("../native/ProjectChipIconImages", () => ({
  projectGlyphImageAtom: () => null,
  projectGlyphKey: () => "",
}));

import { useContextChipIcons, useLiveThreadLinkLabels } from "./entities";

const environmentId = EnvironmentId.make("environment-1");
const href = "goat-thread://v1/unheld";
const markdown = `See [agent label](${href}).`;

function read(resolution: typeof state.resolution) {
  state.resolution = resolution;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const registry = AtomRegistry.make();
  const root = createRoot(document.createElement("div"));
  const reads: Array<{ labels: string; icons: ReadonlyMap<string, string> }> = [];
  function Probe({ report }: { readonly report: (read: (typeof reads)[number]) => void }) {
    report({
      labels: useLiveThreadLinkLabels(markdown, environmentId),
      icons: useContextChipIcons(environmentId, markdown),
    });
    return null;
  }
  act(() =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <Probe report={(read) => reads.push(read)} />
      </RegistryContext.Provider>,
    ),
  );
  act(() => root.unmount());
  registry.dispose();
  const last = reads.at(-1);
  if (last === undefined) throw new Error("The probe did not render");
  return last;
}

it("labels and icons an unheld thread link from the lookup's answer", () => {
  const unheld = ThreadId.make("unheld");
  const answered = read({
    checked: new Set([unheld]),
    titles: { [unheld]: "Fix the build" },
    projectIds: { [unheld]: ProjectId.make("project-a") },
  });
  expect(answered.labels).toBe(`See [Fix the build](${href}).`);
  expect(answered.icons?.get(href)).toBe("icon:project-a");

  // The thread's project is gone: the title, and no icon.
  const projectGone = read({
    checked: new Set([unheld]),
    titles: { [unheld]: "Fix the build" },
    projectIds: { [unheld]: null },
  });
  expect(projectGone.labels).toBe(`See [Fix the build](${href}).`);
  expect(projectGone.icons?.has(href)).toBe(false);

  // An older server answers titles only; a refused or unanswered read leaves the agent's label.
  const titlesOnly = read({
    checked: new Set([unheld]),
    titles: { [unheld]: "Fix the build" },
    projectIds: {},
  });
  expect(titlesOnly.labels).toBe(`See [Fix the build](${href}).`);
  expect(titlesOnly.icons?.has(href)).toBe(false);
  const unanswered = read({ checked: new Set(), titles: {}, projectIds: {} });
  expect(unanswered.labels).toBe(markdown);
  expect(unanswered.icons?.has(href)).toBe(false);
});

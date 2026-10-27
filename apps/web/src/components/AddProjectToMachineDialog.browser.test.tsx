import { EnvironmentId, ProjectId, type ScopedProjectRef } from "@goat/contracts";
import { scopeProjectRef } from "@goat/client-runtime/environment";
import type { AddProjectTarget } from "../hooks/useAddProjectTargets";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";

const project = vi.hoisted(() => {
  const values = new Map<string, unknown>();
  const listeners = new Map<string, Set<() => void>>();
  const keyOf = (ref: ScopedProjectRef) => `${ref.environmentId}:${ref.projectId}`;
  let targets: readonly AddProjectTarget[] = [];
  return {
    setup: (
      initial: readonly { environmentId: EnvironmentId; id: ProjectId }[],
      availableTargets: readonly AddProjectTarget[] = [],
    ) => {
      values.clear();
      for (const scopedListeners of listeners.values()) {
        for (const listener of scopedListeners) listener();
      }
      listeners.clear();
      for (const value of initial) {
        values.set(keyOf({ environmentId: value.environmentId, projectId: value.id }), value);
      }
      targets = availableTargets;
    },
    get: (ref: ScopedProjectRef) => values.get(keyOf(ref)) ?? null,
    set: (ref: ScopedProjectRef, next: unknown) => {
      values.set(keyOf(ref), next);
      for (const listener of listeners.get(keyOf(ref)) ?? []) listener();
    },
    subscribe: (ref: ScopedProjectRef, listener: () => void) => {
      const key = keyOf(ref);
      const scopedListeners = listeners.get(key) ?? new Set<() => void>();
      listeners.set(key, scopedListeners);
      scopedListeners.add(listener);
      return () => scopedListeners.delete(listener);
    },
    targets: () => targets,
  };
});

vi.mock(import("../state/entities"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await original()),
    readProject: ((ref: ScopedProjectRef) => project.get(ref)) as never,
    subscribeProject: ((ref: ScopedProjectRef, listener: (value: unknown) => void) =>
      project.subscribe(ref, () => listener(project.get(ref)))) as never,
    useProject: ((ref: ScopedProjectRef) =>
      useSyncExternalStore(
        (listener) => project.subscribe(ref, listener),
        () => project.get(ref),
      )) as never,
  };
});
vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: [] })) as never,
}));
vi.mock(import("../hooks/useHandleNewThread"), async (original) => ({
  ...(await original()),
  useNewThreadHandler: (() => () => undefined) as never,
}));
vi.mock(import("../hooks/useAddProjectTargets"), async (original) => ({
  ...(await original()),
  useAddProjectTargets: project.targets,
}));
vi.mock(import("../hooks/useLogicalProjectEnvironments"), async (original) => ({
  ...(await original()),
  useLogicalProjectEnvironments: (() => []) as never,
}));

import {
  AddProjectToMachineDialogHost,
  openAddProjectToMachine,
} from "./AddProjectToMachineDialog";

const environmentId = EnvironmentId.make("environment-1");
const projectRef = scopeProjectRef(environmentId, ProjectId.make("project-1"));
const PROJECT = {
  environmentId,
  id: projectRef.projectId,
  title: "Repo",
  workspaceRoot: "/repo",
  repositoryIdentity: null,
};

describe("AddProjectToMachineDialog", () => {
  it("ignores requests for a project that is already absent", async () => {
    project.setup([]);
    await using _screen = await render(<AddProjectToMachineDialogHost />);

    await act(() => openAddProjectToMachine({ projectRef, targetEnvironmentId: null }));
    await act(() => project.set(projectRef, PROJECT));

    await expect.element(page.getByText("Add to another machine")).not.toBeInTheDocument();
  });

  it("closes when its project goes away", async () => {
    project.setup([PROJECT]);
    await using _screen = await render(<AddProjectToMachineDialogHost />);

    await act(() => openAddProjectToMachine({ projectRef, targetEnvironmentId: null }));
    await expect.element(page.getByText("Add to another machine")).toBeInTheDocument();

    await act(() => project.set(projectRef, null));
    await act(() => project.set(projectRef, PROJECT));
    await expect.element(page.getByText("Add to another machine")).not.toBeInTheDocument();
  });

  it("does not reopen for a project that vanished before the dialog showed", async () => {
    project.setup([PROJECT]);
    await using _screen = await render(<AddProjectToMachineDialogHost />);

    await act(() => {
      openAddProjectToMachine({ projectRef, targetEnvironmentId: null });
      project.set(projectRef, null);
    });
    await act(() => project.set(projectRef, PROJECT));

    await expect.element(page.getByText("Add to another machine")).not.toBeInTheDocument();
  });

  it("resets replacement requests and expires only with the replacement's scoped project (PR #1951)", async () => {
    const replacementEnvironmentId = EnvironmentId.make("environment-2");
    const replacementRef = scopeProjectRef(replacementEnvironmentId, projectRef.projectId);
    const replacement = {
      ...PROJECT,
      environmentId: replacementEnvironmentId,
      title: "Replacement",
      repositoryIdentity: {
        locator: { remoteUrl: "https://example.com/team/replacement.git" },
      },
    };
    const buildMachine = EnvironmentId.make("build-machine");
    const laptop = EnvironmentId.make("laptop");
    project.setup(
      [PROJECT, replacement],
      [
        { environmentId: buildMachine, label: "Build machine", machine: "desktop" },
        { environmentId: laptop, label: "Laptop", machine: "laptop" },
      ],
    );
    await using _screen = await render(<AddProjectToMachineDialogHost />);
    await act(() => openAddProjectToMachine({ projectRef, targetEnvironmentId: buildMachine }));
    await userEvent.fill(page.getByRole("textbox", { name: "Folder on Build machine" }), "/custom");
    const target = page.getByRole("combobox", { name: "Machine to add the project to" });
    await userEvent.click(target);
    await userEvent.click(page.getByRole("option", { name: "Laptop", exact: true }));
    await expect.element(target).toHaveTextContent("Laptop");
    await expect
      .element(page.getByRole("textbox", { name: "Folder on Laptop" }))
      .toHaveValue("/custom");

    await act(() =>
      openAddProjectToMachine({ projectRef: replacementRef, targetEnvironmentId: buildMachine }),
    );
    await expect.element(target).toHaveTextContent("Build machine");
    await expect
      .element(page.getByRole("textbox", { name: "Folder on Build machine" }))
      .toHaveValue("~/replacement");

    await act(() => project.set(projectRef, null));
    await expect.element(page.getByText("Add to another machine")).toBeInTheDocument();
    await expect.element(page.getByText(/Clone Replacement/)).toBeInTheDocument();
    await act(() => project.set(replacementRef, null));
    await expect.element(page.getByText("Add to another machine")).not.toBeInTheDocument();
  });
});

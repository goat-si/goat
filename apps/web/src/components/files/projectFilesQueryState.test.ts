import type { ProjectReadFileResult } from "@goat/contracts";
import { EnvironmentId } from "@goat/contracts";
import { AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const executeQuery = vi.hoisted(() => vi.fn());
vi.mock("@goat/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goat/client-runtime/state/runtime")>()),
  executeAtomQuery: executeQuery,
}));

const registryTasks = vi.hoisted(() => new Set<() => void>());

vi.mock("~/rpc/atomRegistry", async () => {
  const { AtomRegistry } = await import("effect/reactivity");
  return {
    appAtomRegistry: AtomRegistry.make({
      scheduleTask: (task) => {
        registryTasks.add(task);
        return () => {
          registryTasks.delete(task);
        };
      },
    }),
  };
});

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";
import { FileSaveCoordinator } from "./fileSaveCoordinator";
import {
  clearProjectFileQueryData,
  confirmProjectFileQueryData,
  getOptimisticProjectFileQueryData,
  getUnsavedProjectFileQueryData,
  getProjectFileSaveSession,
  reloadProjectFileData,
  resolveProjectFileQueryData,
  setProjectFileQueryData,
} from "./projectFilesQueryState";

const environmentId = EnvironmentId.make("environment-project-files-query-test");
const optimisticFile = projectEnvironment.optimisticFile({
  environmentId,
  cwd: "/repo",
  relativePath: "convex.json",
});

function drainRegistryTasks(): void {
  while (registryTasks.size > 0) {
    const tasks = [...registryTasks];
    registryTasks.clear();
    for (const task of tasks) task();
  }
}

describe("project files queries", () => {
  beforeEach(() => {
    executeQuery.mockResolvedValue(AsyncResult.success(undefined));
  });
  afterEach(() => {
    clearProjectFileQueryData(environmentId, "/repo", "convex.json");
    drainRegistryTasks();
    executeQuery.mockReset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("preserves the loaded version through edits and advances it without clearing a newer draft", () => {
    const textFormat = { encoding: "utf-8", bom: true, lineEnding: "crlf" } as const;
    appAtomRegistry.set(optimisticFile, {
      confirmedAgainst: null,
      data: {
        relativePath: "convex.json",
        contents: "loaded",
        byteLength: 6,
        truncated: false,
        version: "loaded-version",
        textFormat,
      },
    });
    setProjectFileQueryData(environmentId, "/repo", "convex.json", "first draft");
    expect(getUnsavedProjectFileQueryData(environmentId, "/repo", "convex.json")).toMatchObject({
      version: "loaded-version",
      textFormat,
    });
    setProjectFileQueryData(environmentId, "/repo", "convex.json", "newer draft");
    expect(
      confirmProjectFileQueryData(environmentId, "/repo", "convex.json", "first draft", {
        relativePath: "convex.json",
        version: "written-version",
      }),
    ).toBe(false);
    expect(getUnsavedProjectFileQueryData(environmentId, "/repo", "convex.json")).toMatchObject({
      contents: "newer draft",
      version: "written-version",
      textFormat,
    });
    setProjectFileQueryData(environmentId, "/repo", "convex.json", "latest draft");
    expect(getUnsavedProjectFileQueryData(environmentId, "/repo", "convex.json")).toMatchObject({
      contents: "latest draft",
      version: "written-version",
      textFormat,
    });
  });

  it("resumes an unsaved draft after closing the preview and restoring write access", async () => {
    vi.stubGlobal("window", {});
    vi.useFakeTimers();
    const closePreview = appAtomRegistry.mount(optimisticFile);
    let canWrite = true;
    const persist = vi.fn().mockResolvedValue(AsyncResult.success(undefined));
    const onPendingChange = vi.fn();
    const makeCoordinator = () =>
      new FileSaveCoordinator({
        debounceMs: 500,
        canPersist: () => canWrite,
        persist,
        onPendingChange,
        onConfirmed: (contents) =>
          confirmProjectFileQueryData(environmentId, "/repo", "convex.json", contents),
      });
    const initial = makeCoordinator();
    setProjectFileQueryData(environmentId, "/repo", "convex.json", "unsaved draft");
    initial.change("unsaved draft");
    canWrite = false;
    initial.dispose();
    closePreview();
    await vi.runAllTimersAsync();
    drainRegistryTasks();

    expect(persist).not.toHaveBeenCalled();
    expect(onPendingChange).toHaveBeenLastCalledWith(true);
    const unsaved = getUnsavedProjectFileQueryData(environmentId, "/repo", "convex.json");
    expect(unsaved?.contents).toBe("unsaved draft");

    canWrite = true;
    const reopened = makeCoordinator();
    reopened.change(unsaved!.contents);
    await vi.advanceTimersByTimeAsync(500);

    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith("unsaved draft");
    expect(onPendingChange).toHaveBeenLastCalledWith(false);
    expect(getUnsavedProjectFileQueryData(environmentId, "/repo", "convex.json")).toBeNull();
    reopened.dispose();
    drainRegistryTasks();
    expect(appAtomRegistry.getNodes().has(optimisticFile)).toBe(false);
  });

  it("discards a replacement view's recovered draft when delayed disk reload completes", async () => {
    vi.useFakeTimers();
    const session = getProjectFileSaveSession(environmentId, "/repo", "convex.json");
    const persist = vi.fn().mockResolvedValue(AsyncResult.success(undefined));
    const replacement = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });
    let finishRead!: (result: ReturnType<typeof AsyncResult.success>) => void;
    executeQuery.mockReturnValueOnce(
      new Promise((resolve) => {
        finishRead = resolve;
      }),
    );
    setProjectFileQueryData(environmentId, "/repo", "convex.json", "stale draft");
    const reloading = reloadProjectFileData(environmentId, "/repo", "convex.json");
    session.coordinators.add(replacement);
    replacement.change(
      getUnsavedProjectFileQueryData(environmentId, "/repo", "convex.json")!.contents,
    );
    finishRead(AsyncResult.success({ contents: "external edit", version: "external" }));
    await reloading;
    await vi.runAllTimersAsync();
    replacement.dispose();
    session.coordinators.delete(replacement);
    expect(persist).not.toHaveBeenCalled();
    expect(getUnsavedProjectFileQueryData(environmentId, "/repo", "convex.json")).toBeNull();
  });

  it("keeps a reopened editor's newer draft pending when the old editor's write finishes", async () => {
    vi.stubGlobal("window", {});
    vi.useFakeTimers();
    let canWrite = true;
    const saved = AsyncResult.success(undefined);
    let finishFirstWrite!: (result: typeof saved) => void;
    const firstWrite = new Promise<typeof saved>((resolve) => {
      finishFirstWrite = resolve;
    });
    const persist = vi.fn().mockReturnValueOnce(firstWrite).mockResolvedValue(saved);
    const onPendingChange = vi.fn();
    const makeCoordinator = () =>
      new FileSaveCoordinator({
        debounceMs: 500,
        canPersist: () => canWrite,
        persist,
        onPendingChange,
        onConfirmed: (contents) =>
          confirmProjectFileQueryData(environmentId, "/repo", "convex.json", contents),
      });

    const initial = makeCoordinator();
    setProjectFileQueryData(environmentId, "/repo", "convex.json", "first draft");
    initial.change("first draft");
    await vi.advanceTimersByTimeAsync(500);
    initial.dispose();

    const reopened = makeCoordinator();
    setProjectFileQueryData(environmentId, "/repo", "convex.json", "newer draft");
    reopened.change("newer draft");
    canWrite = false;
    finishFirstWrite(saved);
    await vi.runAllTimersAsync();

    expect(persist).toHaveBeenCalledOnce();
    expect(onPendingChange).toHaveBeenLastCalledWith(true);
    expect(getUnsavedProjectFileQueryData(environmentId, "/repo", "convex.json")?.contents).toBe(
      "newer draft",
    );

    canWrite = true;
    reopened.change("newer draft");
    await vi.advanceTimersByTimeAsync(500);
    expect(persist).toHaveBeenLastCalledWith("newer draft");
    expect(onPendingChange).toHaveBeenLastCalledWith(false);
    expect(getUnsavedProjectFileQueryData(environmentId, "/repo", "convex.json")).toBeNull();
    reopened.dispose();
  });

  it("keeps the latest optimistic draft when an older write finishes", () => {
    vi.stubGlobal("window", {});
    const initial = {
      relativePath: "convex.json",
      contents: '{"nodeVersion":"20"}',
      byteLength: 20,
      truncated: false,
    } satisfies ProjectReadFileResult;
    setProjectFileQueryData(environmentId, "/repo", "convex.json", '{"nodeVersion":"220"}');
    setProjectFileQueryData(environmentId, "/repo", "convex.json", '{"nodeVersion":"22"}');

    expect(getOptimisticProjectFileQueryData(environmentId, "/repo", "convex.json")?.contents).toBe(
      '{"nodeVersion":"22"}',
    );

    expect(
      confirmProjectFileQueryData(environmentId, "/repo", "convex.json", '{"nodeVersion":"220"}'),
    ).toBe(false);

    expect(resolveProjectFileQueryData(environmentId, "/repo", "convex.json", initial)).toEqual({
      relativePath: "convex.json",
      contents: '{"nodeVersion":"22"}',
      byteLength: 20,
      truncated: false,
    });

    expect(
      confirmProjectFileQueryData(environmentId, "/repo", "convex.json", '{"nodeVersion":"22"}'),
    ).toBe(true);
  });
});

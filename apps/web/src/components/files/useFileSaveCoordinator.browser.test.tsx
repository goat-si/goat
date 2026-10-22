import { act, render as renderScreen, fakeTimers } from "../../../test/render";
import { LEGACY_PROJECT_FILE_NAME } from "@goat/contracts/legacyT3Names";
import { EnvironmentId, ProjectWriteFileError } from "@goat/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { StrictMode, useEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

const { writeFile, confirmFile, readScope, getUnsavedFile, getFile, reloadFile, getSaveSession } =
  vi.hoisted(() => ({
    writeFile: vi.fn(),
    confirmFile: vi.fn(),
    readScope: vi.fn(),
    getUnsavedFile: vi.fn(),
    getFile: vi.fn(),
    reloadFile: vi.fn(),
    getSaveSession: vi.fn(),
  }));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: readScope,
  useEnvironmentScope: readScope,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => writeFile) as never,
}));
vi.mock(import("./projectFilesQueryState"), async (original) => ({
  ...(await original()),
  confirmProjectFileQueryData: confirmFile,
  getUnsavedProjectFileQueryData: getUnsavedFile,
  getProjectFileData: getFile,
  reloadProjectFileData: reloadFile,
  getProjectFileSaveSession: getSaveSession,
}));

import { FileSaveSession } from "./fileSaveCoordinator";
import { useFileSaveCoordinator } from "./useFileSaveCoordinator";

const environmentId = EnvironmentId.make("save-lifecycle-audit");
const onPendingChange = vi.fn();
const defaultProps = {
  environmentId,
  cwd: "/workspace",
  relativePath: "file.txt",
  onPendingChange,
};
function setup() {
  const stack = new AsyncDisposableStack();
  let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
  let latestCoordinator: ReturnType<typeof useFileSaveCoordinator>;
  let latestChange: (contents: string) => void;
  function FileSurface(props: Parameters<typeof useFileSaveCoordinator>[0]) {
    const coordinator = useFileSaveCoordinator(props);
    useEffect(() => {
      latestChange = (contents) => coordinator.change(contents);
      latestCoordinator = coordinator;
    });
    return null;
  }
  const sessions = new Map<string, FileSaveSession>();
  getSaveSession.mockReset().mockImplementation((...identity) => {
    const key = JSON.stringify(identity);
    if (!sessions.has(key)) sessions.set(key, new FileSaveSession());
    return sessions.get(key)!;
  });
  stack.use(fakeTimers());
  writeFile.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  confirmFile.mockReset();
  readScope.mockReset().mockReturnValue(true);
  getUnsavedFile.mockReset().mockReturnValue(null);
  getFile.mockReset().mockReturnValue(null);
  reloadFile.mockReset().mockImplementation(async (...identity) => {
    getSaveSession(...identity).discard();
    return AsyncResult.success({});
  });
  onPendingChange.mockReset();
  const ui = (props: Parameters<typeof useFileSaveCoordinator>[0]) => (
    <StrictMode>
      <FileSurface {...props} />
    </StrictMode>
  );
  const render = async (props = defaultProps) => {
    if (screen) await screen.rerender(ui(props));
    // The hook has no navigation, so a router would add unrelated lifecycle work.
    else screen = stack.use(await renderScreen(ui(props), { router: false }));
    const mounted = screen;
    return {
      changeHandler: () => latestChange,
      rerender: (next: Parameters<typeof useFileSaveCoordinator>[0]) => mounted.rerender(ui(next)),
      unmount: mounted.unmount,
      [Symbol.asyncDispose]: () => mounted[Symbol.asyncDispose](),
    };
  };
  return {
    render,
    mount: render,
    FileSurface,
    changeHandler: () => latestChange,
    get coordinator() {
      return latestCoordinator;
    },
    root: { render: (element: React.ReactNode) => screen!.rerender(element) },
    unmountSurface: async () => {
      await screen?.unmount();
      screen = undefined;
    },
    [Symbol.asyncDispose]: () => stack.disposeAsync(),
  };
}

describe("file-save React lifecycle", () => {
  it.each(["changed_on_disk", "deleted_on_disk"] as const)(
    "keeps the draft and pauses %s until explicit overwrite",
    async (failure) => {
      await using fixture = setup();
      const { mount, changeHandler } = fixture;

      getFile.mockReturnValue({
        version: "loaded-version",
        textFormat: { encoding: "utf-8", bom: true, lineEnding: "crlf" },
      });
      writeFile.mockResolvedValueOnce(
        AsyncResult.failure(
          Cause.fail(
            new ProjectWriteFileError({ cwd: "/workspace", relativePath: "file.txt", failure }),
          ),
        ),
      );
      await mount();
      changeHandler()("draft");
      await act(async () => vi.advanceTimersByTimeAsync(500));
      expect(writeFile.mock.calls[0]![0].input).toMatchObject({
        expectedVersion: "loaded-version",
        textFormat: { bom: true, lineEnding: "crlf" },
      });
      expect(confirmFile).not.toHaveBeenCalled();
      changeHandler()("newer draft");
      await act(async () => vi.advanceTimersByTimeAsync(500));
      expect(writeFile).toHaveBeenCalledTimes(1);
      await act(async () => fixture.coordinator.overwrite());
      expect(writeFile.mock.calls[1]![0].input).toEqual({
        cwd: "/workspace",
        relativePath: "file.txt",
        contents: "newer draft",
        textFormat: { encoding: "utf-8", bom: true, lineEnding: "crlf" },
      });
    },
  );

  it("reloads a conflict without persisting the dirty draft on close", async () => {
    await using fixture = setup();
    const { mount, changeHandler, unmountSurface } = fixture;

    writeFile.mockResolvedValue(
      AsyncResult.failure(
        Cause.fail(
          new ProjectWriteFileError({
            cwd: "/workspace",
            relativePath: "file.txt",
            failure: "changed_on_disk",
          }),
        ),
      ),
    );
    await mount();
    changeHandler()("draft");
    await act(async () => vi.advanceTimersByTimeAsync(500));
    await act(async () => fixture.coordinator.reload());
    expect(reloadFile).toHaveBeenCalledExactlyOnceWith(environmentId, "/workspace", "file.txt");
    await unmountSurface();
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(onPendingChange).toHaveBeenLastCalledWith("file.txt", false);
  });

  it("discards a delayed reload's draft across source/Markdown view switches", async () => {
    await using fixture = setup();
    const { mount, changeHandler, root, FileSurface } = fixture;

    getFile.mockReturnValue({ version: "loaded" });
    getUnsavedFile.mockReturnValue({ contents: "stale draft" });
    writeFile.mockResolvedValueOnce(
      AsyncResult.failure(
        Cause.fail(
          new ProjectWriteFileError({
            cwd: "/workspace",
            relativePath: "file.txt",
            failure: "changed_on_disk",
          }),
        ),
      ),
    );
    await mount();
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(writeFile).toHaveBeenCalledTimes(1);
    let finishReload!: () => void;
    reloadFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishReload = () => {
            getUnsavedFile.mockReturnValue(null);
            getFile.mockReturnValue({ version: "reloaded" });
            getSaveSession(environmentId, "/workspace", "file.txt").discard();
            resolve(AsyncResult.success({}));
          };
        }),
    );
    let reloading!: Promise<void>;
    await act(() => {
      reloading = fixture.coordinator.reload();
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(() =>
      root!.render(
        <StrictMode>
          <FileSurface key="markdown" {...defaultProps} />
        </StrictMode>,
      ),
    );
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      finishReload();
      await reloading;
    });
    await act(async () => vi.runAllTimersAsync());
    expect(writeFile).toHaveBeenCalledTimes(1);
    changeHandler()("explicit post-reload edit");
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(writeFile.mock.calls[1]![0].input).toMatchObject({
      contents: "explicit post-reload edit",
      expectedVersion: "reloaded",
    });
  });

  it("retains a conflict across view switches until explicit overwrite", async () => {
    await using fixture = setup();
    const { mount, root, FileSurface } = fixture;

    getFile.mockReturnValue({ version: "loaded" });
    getUnsavedFile.mockReturnValue({ contents: "draft" });
    writeFile.mockResolvedValueOnce(
      AsyncResult.failure(
        Cause.fail(
          new ProjectWriteFileError({
            cwd: "/workspace",
            relativePath: "file.txt",
            failure: "changed_on_disk",
          }),
        ),
      ),
    );
    await mount();
    await act(async () => vi.advanceTimersByTimeAsync(500));
    await act(() =>
      root!.render(
        <StrictMode>
          <FileSurface key="markdown" {...defaultProps} />
        </StrictMode>,
      ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(fixture.coordinator.status).toBe("changed");
    await act(async () => fixture.coordinator.overwrite());
    expect(writeFile.mock.calls[1]![0].input).not.toHaveProperty("expectedVersion");
  });

  it("resolves the next view's expected version after the pending save confirms", async () => {
    await using fixture = setup();
    const { mount, changeHandler, root, FileSurface } = fixture;

    getFile.mockReturnValue({ version: "loaded" });
    const saved = AsyncResult.success({ relativePath: "file.txt", version: "first-written" });
    let finishWrite!: (value: typeof saved) => void;
    writeFile.mockReturnValueOnce(
      new Promise<typeof saved>((resolve) => {
        finishWrite = resolve;
      }),
    );
    writeFile.mockImplementation(async ({ input }) =>
      input.expectedVersion === "first-written"
        ? AsyncResult.success({ relativePath: "file.txt", version: "second-written" })
        : AsyncResult.failure(
            Cause.fail(
              new ProjectWriteFileError({
                cwd: "/workspace",
                relativePath: "file.txt",
                failure: "changed_on_disk",
              }),
            ),
          ),
    );
    confirmFile.mockImplementation((_env, _cwd, _path, contents, written) => {
      getFile.mockReturnValue({ version: written.version });
      return contents === "second edit";
    });
    await mount();
    changeHandler()("first edit");
    await act(async () => vi.advanceTimersByTimeAsync(500));
    await act(() =>
      root!.render(
        <StrictMode>
          <FileSurface key="markdown" {...defaultProps} />
        </StrictMode>,
      ),
    );
    changeHandler()("second edit");
    await act(async () => vi.advanceTimersByTimeAsync(500));
    await act(async () => {
      finishWrite(saved);
    });
    expect(writeFile).toHaveBeenCalledTimes(2);
    expect(writeFile.mock.calls[1]![0].input).toMatchObject({
      contents: "second edit",
      expectedVersion: "first-written",
    });
    expect(fixture.coordinator.status).toBe("saved");
  });

  it("persists editor model changes after StrictMode setup replay", async () => {
    await using fixture = setup();
    const { mount } = fixture;

    await using screen = await mount();
    screen.changeHandler()("AUDIT7907NATIVE\n");
    expect(onPendingChange).toHaveBeenCalledWith("file.txt", true);
    await vi.advanceTimersByTimeAsync(500);
    expect(writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { cwd: "/workspace", relativePath: "file.txt", contents: "AUDIT7907NATIVE\n" },
    });
    expect(confirmFile).toHaveBeenCalledExactlyOnceWith(
      environmentId,
      "/workspace",
      "file.txt",
      "AUDIT7907NATIVE\n",
      undefined,
    );
    expect(onPendingChange).toHaveBeenLastCalledWith("file.txt", false);
  });

  it("saves an existing legacy project file to the path that was read", async () => {
    await using fixture = setup();
    const { mount, changeHandler } = fixture;

    await mount({ ...defaultProps, relativePath: LEGACY_PROJECT_FILE_NAME });
    changeHandler()('{ "iconPath": "updated.svg" }');
    await vi.advanceTimersByTimeAsync(500);
    expect(writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        cwd: "/workspace",
        relativePath: LEGACY_PROJECT_FILE_NAME,
        contents: '{ "iconPath": "updated.svg" }',
      },
    });
  });

  it("flushes on unmount and ignores a retired editor callback", async () => {
    await using fixture = setup();
    const { mount } = fixture;

    await using screen = await mount();
    const retiredChange = screen.changeHandler();
    retiredChange("pending edit");
    await screen.unmount();
    retiredChange("stale editor contents");
    await vi.runAllTimersAsync();
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0]![0].input.contents).toBe("pending edit");
  });

  it.each([false, true])(
    "keeps edits pending after permission is revoked before a React update (unmount: %s)",
    async (unmount) => {
      await using fixture = setup();
      const { mount } = fixture;

      await using screen = await mount();
      screen.changeHandler()("pending edit");
      readScope.mockReturnValue(false);
      if (unmount) {
        await screen.unmount();
      }
      await vi.runAllTimersAsync();
      expect(writeFile).not.toHaveBeenCalled();
      expect(confirmFile).not.toHaveBeenCalled();
      expect(onPendingChange).toHaveBeenLastCalledWith("file.txt", true);
    },
  );

  it("resumes an unsaved draft when write permission returns after effect replay", async () => {
    await using fixture = setup();
    const { mount } = fixture;

    readScope.mockReturnValue(false);
    getUnsavedFile.mockReturnValue({ contents: "pending draft" });
    await using screen = await mount();
    await vi.runAllTimersAsync();
    expect(writeFile).not.toHaveBeenCalled();

    readScope.mockReturnValue(true);
    await screen.rerender(defaultProps);
    await vi.advanceTimersByTimeAsync(500);
    expect(writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { cwd: "/workspace", relativePath: "file.txt", contents: "pending draft" },
    });
    expect(onPendingChange).toHaveBeenLastCalledWith("file.txt", false);
  });

  it.each([
    { relativePath: "other.txt" },
    { cwd: "/other-workspace" },
    { environmentId: EnvironmentId.make("other-environment") },
  ])("retires callbacks when the file identity changes: %j", async (change) => {
    await using fixture = setup();
    const { mount } = fixture;

    await using screen = await mount();
    const retiredChange = screen.changeHandler();
    retiredChange("old file edit");
    const nextProps = { ...defaultProps, ...change };
    await screen.rerender(nextProps);
    retiredChange("stale editor contents");
    screen.changeHandler()("new file edit");
    await vi.runAllTimersAsync();
    expect(writeFile.mock.calls.map(([request]) => request)).toEqual([
      {
        environmentId,
        input: { cwd: "/workspace", relativePath: "file.txt", contents: "old file edit" },
      },
      {
        environmentId: nextProps.environmentId,
        input: {
          cwd: nextProps.cwd,
          relativePath: nextProps.relativePath,
          contents: "new file edit",
        },
      },
    ]);
  });
});

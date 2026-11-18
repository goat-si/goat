import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import { PRIMARY_INSTANCE_ID } from "../../backend/DesktopBackendManager.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { startFileDrag } from "./fileDrag.ts";

const { getFileIcon } = vi.hoisted(() => ({ getFileIcon: vi.fn() }));
vi.mock("electron", () => ({ app: { getFileIcon } }));

const windowsHost = HostProcess.Platform.defaultValue() === "win32";

const setup = Effect.fn("fileDrag.test.setup")(function* (platform: NodeJS.Platform = "darwin") {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-file-drag-" });
  const file = path.join(stateDir, "readme.txt");
  yield* fs.writeFileString(path.join(stateDir, "environment-id"), "local-environment\n");
  yield* fs.writeFileString(file, "file contents");
  const frame = { id: 1 };
  const startDrag = vi.fn();
  const contents = { id: 1, mainFrame: frame, isDestroyed: () => false, startDrag };
  const window = { webContents: contents } as unknown as Electron.BrowserWindow;
  const icon = { mockIcon: true };
  getFileIcon.mockReset().mockResolvedValue(icon);

  const invocations = new Map<string, DesktopIpc.DesktopIpcHandleListener>();
  const ipc = DesktopIpc.make(
    {
      removeHandler: (channel) => invocations.delete(channel),
      handle: (channel, listener) => invocations.set(channel, listener),
      removeAllListeners: () => {},
      on: () => {},
    },
    Effect.succeedSome({ webContents: contents }),
  );
  const primary = {
    id: PRIMARY_INSTANCE_ID,
    label: Effect.succeed("Native"),
    start: Effect.void,
    stop: () => Effect.void,
    currentConfig: Effect.succeedNone,
    snapshot: Effect.succeed({
      desiredRunning: true,
      ready: true,
      activePid: Option.some(1),
      restartAttempt: 0,
      restartScheduled: false,
    }),
    waitForReady: () => Effect.succeed(true),
  };
  yield* ipc
    .handle(startFileDrag)
    .pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(DesktopEnvironment.DesktopEnvironment)({ path, platform, stateDir }),
          Layer.mock(ElectronWindow.ElectronWindow)({ main: Effect.succeedSome(window) }),
          DesktopBackendPool.layerTest([primary]),
          DesktopAppSettings.layerTest(),
        ),
      ),
    );

  const listener = invocations.get(startFileDrag.channel);
  if (!listener) throw new Error("Finder drag channel was not registered");
  const invoke = (
    path: string,
    environmentId = "local-environment",
    event: DesktopIpc.DesktopIpcIncomingEvent = { sender: contents, senderFrame: frame },
  ) => Promise.resolve().then(() => listener(event, { path, environmentId }));
  return { invoke, file, stateDir, contents, startDrag, icon };
});

it.effect.skipIf(windowsHost)(
  "starts Finder drag with the real local file from the trusted top frame",
  () =>
    Effect.gen(function* () {
      const { invoke, file, startDrag, icon } = yield* setup();
      const fs = yield* FileSystem.FileSystem;
      const canonicalFile = yield* fs.realPath(file);
      assert.isTrue(yield* Effect.promise(() => invoke(file)));
      assert.deepEqual(startDrag.mock.calls, [[{ file: canonicalFile, icon }]]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "refuses remote ids, invalid files, and untrusted IPC senders before loading an icon",
  () =>
    Effect.gen(function* () {
      const { invoke, file, stateDir, contents, startDrag } = yield* setup();
      for (const path of ["readme.txt", "//remote/share/readme.txt", stateDir, `${file}.missing`]) {
        assert.isFalse(yield* Effect.promise(() => invoke(path)));
      }
      assert.isFalse(yield* Effect.promise(() => invoke(file, "remote-environment")));
      const foreignFrame = { sender: contents, senderFrame: { id: 2 } };
      const foreignWindow = { sender: { ...contents }, senderFrame: contents.mainFrame };
      for (const event of [foreignFrame, foreignWindow]) {
        const rejected = yield* Effect.tryPromise({
          try: () => invoke(file, "local-environment", event),
          catch: (error) => error,
        }).pipe(Effect.flip);
        assert.match(String(rejected), /untrusted sender/);
      }
      assert.lengthOf(getFileIcon.mock.calls, 0);
      assert.lengthOf(startDrag.mock.calls, 0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.skipIf(windowsHost)(
  "discards the native drag if the top frame changed while the icon was loading",
  () =>
    Effect.gen(function* () {
      const { invoke, file, contents, startDrag, icon } = yield* setup();
      getFileIcon.mockImplementation(async () => {
        contents.mainFrame = { id: 2 };
        return icon;
      });
      assert.isFalse(yield* Effect.promise(() => invoke(file)));
      assert.lengthOf(startDrag.mock.calls, 0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("refuses the Finder channel on unsupported platforms", () =>
  Effect.gen(function* () {
    const { file, invoke, startDrag } = yield* setup("win32");
    assert.isFalse(yield* Effect.promise(() => invoke(file)));
    assert.lengthOf(getFileIcon.mock.calls, 0);
    assert.lengthOf(startDrag.mock.calls, 0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

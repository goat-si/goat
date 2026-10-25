import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it, vi } from "vite-plus/test";

import { createRestartController, readOutputFingerprint } from "./dev-electron-restart.ts";

const debounceMs = 120;
const files = ["main.cjs", "preview-pick-preload.cjs", "snapShot/Worker.cjs"];

function outputDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-dev-electron-"));
  NodeFS.mkdirSync(NodePath.join(directory, "snapShot"));
  const write = (file: string, contents: string) =>
    NodeFS.writeFileSync(NodePath.join(directory, file), contents);
  for (const file of files) write(file, `${file} v1`);
  return {
    directory,
    write,
    remove: (file: string) => NodeFS.rmSync(NodePath.join(directory, file)),
    fingerprint: () => readOutputFingerprint(directory, files),
    [Symbol.dispose]: () => NodeFS.rmSync(directory, { recursive: true, force: true }),
  };
}

function launchedApp(output: ReturnType<typeof outputDirectory>) {
  vi.useFakeTimers();
  const events: Array<"start" | "stop"> = [];
  const controller = createRestartController({
    readOutputs: output.fingerprint,
    stopApp: async () => {
      events.push("stop");
    },
    startApp: () => {
      events.push("start");
    },
    debounceMs,
  });
  controller.launch();
  return {
    controller,
    relaunches: () => events.filter((event) => event === "stop").length,
    settle: async () => {
      await vi.advanceTimersByTimeAsync(debounceMs);
      await controller.settled();
    },
    [Symbol.asyncDispose]: async () => {
      await controller.close();
      vi.useRealTimers();
    },
  };
}

describe("dev Electron output fingerprint", () => {
  it("ignores a hard link and a byte-identical rewrite but sees an edit or a missing file", () => {
    using output = outputDirectory();
    const launched = output.fingerprint();
    const elsewhere = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-dev-electron-link-"));
    try {
      NodeFS.linkSync(
        NodePath.join(output.directory, "main.cjs"),
        NodePath.join(elsewhere, "link"),
      );
      output.write("main.cjs", "main.cjs v1");
      assert.equal(output.fingerprint(), launched);

      output.write("main.cjs", "main.cjs v2");
      assert.notEqual(output.fingerprint(), launched);

      output.remove("main.cjs");
      assert.isNull(output.fingerprint());
    } finally {
      NodeFS.rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe("dev Electron relaunch", () => {
  it("does not relaunch for rebuilds that write the same bytes after a metadata-only change", async () => {
    using output = outputDirectory();
    await using app = launchedApp(output);
    for (let rebuild = 0; rebuild < 3; rebuild += 1) {
      app.controller.buildStarted();
      output.write("main.cjs", "main.cjs v1");
      app.controller.buildFinished();
      await app.settle();
    }
    assert.equal(app.relaunches(), 0);
  });

  it("relaunches once for a changed build however many times it is reported", async () => {
    using output = outputDirectory();
    await using app = launchedApp(output);
    app.controller.buildStarted();
    output.write("main.cjs", "main.cjs v2");
    app.controller.buildFinished();
    await vi.advanceTimersByTimeAsync(debounceMs / 2);
    app.controller.buildFinished();
    await app.settle();
    app.controller.buildFinished();
    await app.settle();
    assert.equal(app.relaunches(), 1);
  });

  it("waits while a build is in flight and relaunches once into the finished generation", async () => {
    using output = outputDirectory();
    await using app = launchedApp(output);
    app.controller.buildStarted();
    output.write("main.cjs", "main.cjs v2");
    app.controller.request();
    await app.settle();
    assert.equal(app.relaunches(), 0);

    output.write("snapShot/Worker.cjs", "snapShot/Worker.cjs v2");
    app.controller.buildFinished();
    await app.settle();
    assert.equal(app.relaunches(), 1);

    app.controller.buildStarted();
    app.controller.buildFinished();
    await app.settle();
    assert.equal(app.relaunches(), 1);
  });

  it("holds a relaunch while an output is missing and relaunches once it is written", async () => {
    using output = outputDirectory();
    await using app = launchedApp(output);
    output.remove("main.cjs");
    app.controller.request();
    await app.settle();
    assert.equal(app.relaunches(), 0);

    output.write("main.cjs", "main.cjs v2");
    app.controller.request();
    await app.settle();
    assert.equal(app.relaunches(), 1);
  });

  it("does not relaunch when an edit is reverted before the check runs", async () => {
    using output = outputDirectory();
    await using app = launchedApp(output);
    output.write("main.cjs", "main.cjs v2");
    app.controller.request();
    output.write("main.cjs", "main.cjs v1");
    await app.settle();
    assert.equal(app.relaunches(), 0);
  });

  it("relaunches for a preload-only edit", async () => {
    using output = outputDirectory();
    await using app = launchedApp(output);
    app.controller.buildStarted();
    output.write("preview-pick-preload.cjs", "preview-pick-preload.cjs v2");
    app.controller.buildFinished();
    await app.settle();
    assert.equal(app.relaunches(), 1);
  });

  it("relaunches after an Electron crash even when the outputs are unchanged", async () => {
    using output = outputDirectory();
    await using app = launchedApp(output);
    app.controller.request(true);
    app.controller.request();
    app.controller.buildStarted();
    await app.settle();
    assert.equal(app.relaunches(), 1);
  });

  it("ends on the finished generation when a build starts while the old app is stopping", async () => {
    using output = outputDirectory();
    vi.useFakeTimers();
    const stopping = Promise.withResolvers<void>();
    let starts = 0;
    let stops = 0;
    const controller = createRestartController({
      readOutputs: output.fingerprint,
      stopApp: () => {
        stops += 1;
        return stops === 1 ? stopping.promise : Promise.resolve();
      },
      startApp: () => {
        starts += 1;
      },
      debounceMs,
    });
    try {
      controller.launch();
      output.write("main.cjs", "main.cjs v2");
      controller.buildFinished();
      await vi.advanceTimersByTimeAsync(debounceMs);

      controller.buildStarted();
      output.remove("snapShot/Worker.cjs");
      stopping.resolve();
      await controller.settled();
      assert.deepEqual({ starts, stops }, { starts: 2, stops: 1 });

      output.write("snapShot/Worker.cjs", "snapShot/Worker.cjs v2");
      controller.buildFinished();
      await vi.advanceTimersByTimeAsync(debounceMs);
      await controller.settled();
      controller.buildStarted();
      controller.buildFinished();
      await vi.advanceTimersByTimeAsync(debounceMs);
      await controller.settled();
      assert.deepEqual({ starts, stops }, { starts: 3, stops: 2 });
    } finally {
      await controller.close();
      vi.useRealTimers();
    }
  });
});

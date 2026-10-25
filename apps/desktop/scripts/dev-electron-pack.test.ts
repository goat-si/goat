import * as NodeEvents from "node:events";

import { assert, describe, it } from "vite-plus/test";

import { createDevElectronBuildCoordinator } from "./dev-electron-pack.ts";

class FakeLauncher extends NodeEvents.EventEmitter {
  connected = true;
  readonly states: Array<string> = [];
  send(message: { readonly state: string }, callback: (error: Error | null) => void) {
    this.states.push(message.state);
    callback(null);
    return true;
  }
}

function coordinator() {
  const launchers: Array<FakeLauncher> = [];
  const builds = createDevElectronBuildCoordinator(() => {
    const launcher = new FakeLauncher();
    launchers.push(launcher);
    return launcher;
  });
  return { builds, launchers };
}

describe("dev Electron build coordinator", () => {
  it("starts one launcher after every config has built and reports each later generation to it", () => {
    const { builds, launchers } = coordinator();
    builds.buildStarted(0);
    builds.buildStarted(1);
    builds.buildSucceeded(0);
    assert.lengthOf(launchers, 0);

    builds.buildSucceeded(1);
    assert.lengthOf(launchers, 1);
    assert.deepEqual(launchers[0]?.states, ["idle"]);

    builds.buildStarted(0);
    builds.buildStarted(1);
    builds.buildSucceeded(1);
    builds.buildSucceeded(0);
    assert.lengthOf(launchers, 1);
    assert.deepEqual(launchers[0]?.states, ["idle", "building", "idle"]);
  });

  it("holds the idle report while a failed config has not built again", () => {
    const { builds, launchers } = coordinator();
    builds.buildStarted(0);
    builds.buildSucceeded(0);
    builds.buildStarted(0);
    builds.buildStarted(1);
    builds.buildSucceeded(0);
    assert.deepEqual(launchers[0]?.states, ["idle", "building"]);

    builds.buildStarted(1);
    builds.buildSucceeded(1);
    assert.deepEqual(launchers[0]?.states, ["idle", "building", "idle"]);
  });

  it("replaces a launcher that failed or exited, and a stale exit keeps the replacement", () => {
    const { builds, launchers } = coordinator();
    builds.buildStarted(0);
    builds.buildSucceeded(0);
    launchers[0]?.emit("error", new Error("spawn failed"));

    builds.buildStarted(0);
    builds.buildSucceeded(0);
    assert.lengthOf(launchers, 2);
    launchers[0]?.emit("exit", 1);

    builds.buildStarted(0);
    builds.buildSucceeded(0);
    assert.lengthOf(launchers, 2);
    assert.deepEqual(launchers[1]?.states, ["idle", "building", "idle"]);
  });
});

// @effect-diagnostics nodeBuiltinImport:off -- The installer is tested against real directories, links and renames.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { type HelperInstallDependencies, makeHelperInstaller } from "./ComputerUseHelperInstall.ts";

const TEAM = "U9ATA49N28";
const ID = "si.goat.desktop.computer-use";
const APP = "GOAT Computer Use.app";

interface FakeSignature {
  readonly cdhash: string;
  readonly team?: string;
  readonly identifier?: string;
  readonly granted?: boolean;
  readonly hello?: boolean;
}

/** A bundle whose "signature" is a JSON file codesign would otherwise read from the seal. */
async function bundle(path: string, signature: FakeSignature) {
  await NodeFSP.mkdir(NodePath.join(path, "Contents", "MacOS"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(path, "Contents", "signature.json"),
    JSON.stringify(signature),
  );
}
const read = async (path: string): Promise<FakeSignature | undefined> =>
  NodeFSP.readFile(NodePath.join(path, "Contents", "signature.json"), "utf8").then(
    (text) => JSON.parse(text) as FakeSignature,
    () => undefined,
  );

async function fixture() {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-helper-install-"));
  const app = NodePath.join(dir, "GOAT.app");
  const source = NodePath.join(app, "Contents", "Helpers", APP);
  const root = NodePath.join(dir, "state", "computer-use-helper");
  await bundle(app, { cdhash: "app", team: TEAM, identifier: "si.goat.desktop" });
  const copies: string[] = [];
  const dependencies: HelperInstallDependencies = {
    signature: async (path) => {
      const signature = await read(path);
      return signature ? { cdhash: signature.cdhash, team: signature.team } : undefined;
    },
    satisfies: async (path, requirement) => {
      const signature = await read(path);
      return (
        signature?.team !== undefined &&
        requirement.includes('"' + signature.team + '"') &&
        requirement.endsWith('identifier "' + (signature.identifier ?? ID) + '"')
      );
    },
    copy: async (from, to) => {
      copies.push(from);
      await NodeFSP.cp(from, to, { recursive: true });
    },
    probe: async (path) => {
      if ((await read(path))?.hello === false) throw new Error("no hello");
    },
    grants: async (path) => {
      const granted = (await read(path))?.granted ?? true;
      return { accessibility: granted, screenRecording: granted };
    },
  };
  return {
    [Symbol.asyncDispose]: () => NodeFSP.rm(dir, { recursive: true, force: true }),
    dir,
    app,
    root,
    copies,
    install: makeHelperInstaller(dependencies),
    ship: (signature: Omit<FakeSignature, "team"> & { readonly team?: string }) =>
      NodeFSP.rm(source, { recursive: true, force: true }).then(() =>
        bundle(source, { team: TEAM, ...signature }),
      ),
    input: (busy = false) => ({ app, source, bundleId: ID, root, busy }),
    link: (name: string) =>
      NodeFSP.readlink(NodePath.join(root, name)).then(NodePath.basename, () => undefined),
    generations: () =>
      NodeFSP.readdir(NodePath.join(root, "generations")).then((names) => names.sort()),
    fresh: () => makeHelperInstaller(dependencies),
  };
}

describe("ComputerUseHelperInstall", () => {
  it("installs a generation once, then runs it without copying again", async () => {
    await using f = await fixture();
    await f.ship({ cdhash: "g1" });
    const first = await f.install(f.input());
    assert.deepEqual(first, {
      kind: "found",
      path: NodePath.join(f.root, "generations", "g1", APP),
    });
    assert.equal(await f.link("current"), "g1");
    assert.isUndefined(await f.link("previous"));
    // A new process, as after relaunching GOAT, finds it installed.
    assert.deepEqual(await f.fresh()(f.input()), first);
    assert.lengthOf(f.copies, 1);
  });

  it("switches to a new generation, keeps the last one for rollback and prunes older ones", async () => {
    await using f = await fixture();
    for (const cdhash of ["g1", "g2", "g3"]) {
      await f.ship({ cdhash });
      await f.install(f.input());
    }
    assert.equal(await f.link("current"), "g3");
    assert.equal(await f.link("previous"), "g2");
    assert.deepEqual(await f.generations(), ["g2", "g3"]);
  });

  it("waits to switch while a helper runs, then switches once it stopped", async () => {
    await using f = await fixture();
    await f.ship({ cdhash: "g1" });
    await f.install(f.input());
    await f.ship({ cdhash: "g2" });
    const busy = await f.install(f.input(true));
    assert.equal(busy.kind === "found" && NodePath.basename(NodePath.dirname(busy.path)), "g1");
    assert.equal(await f.link("current"), "g1");
    await f.install(f.input(false));
    assert.equal(await f.link("current"), "g2");
  });

  it("replaces an installed copy that no longer meets GOAT's team and identifier", async () => {
    await using f = await fixture();
    await f.ship({ cdhash: "g1" });
    await f.install(f.input());
    await bundle(NodePath.join(f.root, "generations", "g1", APP), {
      cdhash: "g1",
      team: "ATTACKER1",
    });
    const result = await f.fresh()(f.input());
    assert.equal(result.kind, "found");
    assert.equal((await read(NodePath.join(f.root, "generations", "g1", APP)))?.team, TEAM);
    // Busy, a tampered copy is never used: the sealed copy in GOAT.app runs instead.
    await bundle(NodePath.join(f.root, "generations", "g1", APP), {
      cdhash: "g1",
      team: "ATTACKER1",
    });
    assert.deepEqual(await f.fresh()(f.input(true)), {
      kind: "found",
      path: NodePath.join(f.app, "Contents", "Helpers", APP),
    });
  });

  it("leaves the current generation in place when the new one does not answer hello", async () => {
    await using f = await fixture();
    await f.ship({ cdhash: "g1" });
    await f.install(f.input());
    await f.ship({ cdhash: "g2", hello: false });
    const failed = await f.install(f.input()).then(
      () => undefined,
      (error: Error) => error.message,
    );
    assert.equal(failed, "no hello");
    assert.equal(await f.link("current"), "g1");
    assert.deepEqual(await f.generations(), ["g1"]);
  });

  it("rolls back a generation that lost the grants its predecessor had, and does not retry it", async () => {
    await using f = await fixture();
    await f.ship({ cdhash: "g1", granted: true });
    await f.install(f.input());
    await f.ship({ cdhash: "g2", granted: false });
    const result = await f.install(f.input());
    assert.equal(result.kind === "found" && NodePath.basename(NodePath.dirname(result.path)), "g1");
    assert.match(result.kind === "found" ? (result.note ?? "") : "", /lost its Accessibility/);
    assert.equal(await f.link("current"), "g1");
    assert.equal(await f.link("previous"), "g2");
    assert.equal(await f.link("rejected"), "g2");
    const copies = f.copies.length;
    await f.fresh()(f.input());
    assert.lengthOf(f.copies, copies);
    // A later build moves forward again.
    await f.ship({ cdhash: "g3", granted: true });
    await f.install(f.input());
    assert.equal(await f.link("current"), "g3");
    assert.isUndefined(await f.link("rejected"));
  });

  it("runs an ad-hoc build's helper in place and refuses a helper signed for another app", async () => {
    await using f = await fixture();
    await bundle(f.app, { cdhash: "app" });
    await f.ship({ cdhash: "g1" });
    assert.deepEqual(await f.install(f.input()), {
      kind: "found",
      path: NodePath.join(f.app, "Contents", "Helpers", APP),
    });
    assert.deepEqual(await NodeFSP.readdir(f.dir), ["GOAT.app"]);

    await using g = await fixture();
    await g.ship({ cdhash: "g1", identifier: "si.goat.desktop.nightly.computer-use" });
    assert.equal((await g.install(g.input())).kind, "unusable");
  });
});

// @effect-diagnostics nodeBuiltinImport:off -- This desktop-only module owns the installed helper's directories and links.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { COMPUTER_USE_HELPER_NAME } from "@goat/shared/cuaDriverRelease";

import {
  classifyHelperBundle,
  helperBundle,
  openHelperSession,
  probeHelperGrants,
  spawnHelperProcess,
} from "./ComputerUseHelper.ts";
import { windowsHelperBundle } from "./ComputerUseHelperWindows.ts";

/**
 * The installed copy of "GOAT Computer Use.app" (ADR-0023, #1162). A Developer ID GOAT.app seeds
 * it from Contents/Helpers into the desktop state directory and runs it from there:
 *
 *   computer-use-helper/generations/<cdhash>/GOAT Computer Use.app
 *   computer-use-helper/current  -> generations/<cdhash>
 *   computer-use-helper/previous -> the generation current replaced, kept for rollback
 *
 * A new generation is copied without extended attributes, must satisfy the running GOAT.app's
 * team and the helper's bundle id with an intact seal, and must answer hello before `current`
 * moves to it by renaming a fresh link over it. The switch waits while a helper runs. After it,
 * a generation that lost the grants its predecessor had is rolled back and remembered in
 * `rejected`, so it is not copied again on every start. Ad-hoc and dev builds run the helper in
 * place: an ad-hoc signature has no team to check a copy against.
 */

export interface HelperCodeSignature {
  readonly cdhash: string;
  /** The Developer ID team, absent for ad-hoc code. */
  readonly team: string | undefined;
}

export interface HelperInstallDependencies {
  readonly signature: (bundle: string) => Promise<HelperCodeSignature | undefined>;
  /** Whether the bundle's seal is intact and it satisfies the requirement text. */
  readonly satisfies: (bundle: string, requirement: string) => Promise<boolean>;
  readonly copy: (from: string, to: string) => Promise<void>;
  /** Starts the bundle's helper and resolves once its hello names the expected bundle id. */
  readonly probe: (bundle: string, bundleId: string) => Promise<void>;
  /** Whether two helper bundles carry byte-identical Cua Driver executables. */
  readonly sameDriver: (bundle: string, other: string) => Promise<boolean>;
  readonly grants: (
    bundle: string,
    bundleId: string,
  ) => Promise<{ readonly accessibility: boolean; readonly screenRecording: boolean }>;
}

export interface HelperInstallInput {
  /** GOAT.app; its team anchors the requirement every installed generation must meet. */
  readonly app: string;
  /** The helper GOAT.app carries, sealed inside it. */
  readonly source: string;
  readonly bundleId: string;
  /** `<stateDir>/computer-use-helper`. */
  readonly root: string;
  /** A helper is running; a switch waits until it has stopped. */
  readonly busy: boolean;
}

export type HelperInstallResult =
  | { readonly kind: "found"; readonly path: string; readonly note?: string }
  | { readonly kind: "unusable"; readonly message: string };

const HELPER_APP = COMPUTER_USE_HELPER_NAME + ".app";
/** A generation directory is named for its code directory hash: no separators, no dots. */
const GENERATION_NAME = /^[0-9A-Za-z]+$/u;
type Grants = { readonly accessibility: boolean; readonly screenRecording: boolean };
const lostGrant = (before: Grants, after: Grants | undefined) =>
  (before.accessibility && !after?.accessibility) ||
  (before.screenRecording && !after?.screenRecording);

export function makeHelperInstaller(dependencies: HelperInstallDependencies) {
  const install = async (input: HelperInstallInput): Promise<HelperInstallResult> => {
    const generations = NodePath.join(input.root, "generations");
    const bundleOf = (generation: string) => NodePath.join(generations, generation, HELPER_APP);
    /** The generation a link this installer wrote names; anything else reads as no link. */
    const linked = async (name: string, mustExist = true) => {
      const target = await NodeFSP.readlink(NodePath.join(input.root, name)).catch(() => undefined);
      const generation = target === undefined ? undefined : NodePath.basename(target);
      if (
        generation === undefined ||
        !GENERATION_NAME.test(generation) ||
        target !== NodePath.join("generations", generation)
      )
        return undefined;
      if (!mustExist) return generation;
      return (await NodeFSP.stat(NodePath.join(generations, generation)).then(
        (stat) => stat.isDirectory(),
        () => false,
      ))
        ? generation
        : undefined;
    };
    const point = async (name: string, generation: string | undefined) => {
      const link = NodePath.join(input.root, name);
      if (generation === undefined) return NodeFSP.rm(link, { force: true });
      const fresh = NodePath.join(input.root, "." + name + "-" + NodeCrypto.randomUUID());
      await NodeFSP.symlink(NodePath.join("generations", generation), fresh);
      // rename(2) replaces the old link in one step, so a reader sees the old or the new one.
      await NodeFSP.rename(fresh, link);
    };

    const team = (await dependencies.signature(input.app))?.team;
    if (team === undefined) return { kind: "found", path: input.source };
    const requirement =
      'anchor apple generic and certificate leaf[subject.OU] = "' +
      team +
      '" and identifier "' +
      input.bundleId +
      '"';
    const wanted = (await dependencies.signature(input.source))?.cdhash;
    if (
      wanted === undefined ||
      !GENERATION_NAME.test(wanted) ||
      !(await dependencies.satisfies(input.source, requirement))
    )
      return {
        kind: "unusable",
        message:
          COMPUTER_USE_HELPER_NAME +
          " in GOAT.app is not signed by GOAT's team as " +
          input.bundleId +
          ".",
      };

    // Checked on every use: the directory is writable by the user, so a name proves nothing.
    const valid = async (generation: string | undefined) =>
      generation !== undefined && (await dependencies.satisfies(bundleOf(generation), requirement));
    const use = (generation: string, note?: string): HelperInstallResult => ({
      kind: "found",
      path: bundleOf(generation),
      ...(note ? { note } : {}),
    });
    const current = await linked("current");
    const currentValid = await valid(current);
    if (current !== undefined && currentValid) {
      if (current === wanted) return use(current);
      if (input.busy || (await linked("rejected", false)) === wanted) return use(current);
    }
    // Busy with a copy that fails its check: the sealed one in GOAT.app is the only safe choice.
    if (input.busy) return { kind: "found", path: input.source };

    await NodeFSP.mkdir(generations, { recursive: true });
    const staging = await NodeFSP.mkdtemp(NodePath.join(generations, ".staging-"));
    try {
      const staged = NodePath.join(staging, HELPER_APP);
      await dependencies.copy(input.source, staged);
      if (
        (await dependencies.signature(staged))?.cdhash !== wanted ||
        !(await dependencies.satisfies(staged, requirement))
      )
        throw new Error("the copy in " + input.root + " does not match GOAT.app's");
      await dependencies.probe(staged, input.bundleId);
      const target = NodePath.join(generations, wanted);
      await NodeFSP.rm(target, { recursive: true, force: true });
      await NodeFSP.rename(staging, target);
    } finally {
      await NodeFSP.rm(staging, { recursive: true, force: true });
    }

    const previous = currentValid && current !== wanted ? current : await linked("previous");
    const kept = previous !== undefined && (await valid(previous)) ? previous : undefined;
    await point("previous", kept);
    await point("current", wanted);
    for (const entry of await NodeFSP.readdir(generations))
      if (entry !== wanted && entry !== kept)
        await NodeFSP.rm(NodePath.join(generations, entry), { recursive: true, force: true });

    // A new code identity can lose grants; keep the generation that still has them, as long as
    // it speaks this app's protocol and carries the same driver, so the host can still run it.
    if (kept !== undefined) {
      const grantsOf = (generation: string) =>
        dependencies.grants(bundleOf(generation), input.bundleId).catch(() => undefined);
      const after = await grantsOf(wanted);
      const before =
        after && after.accessibility && after.screenRecording ? undefined : await grantsOf(kept);
      if (
        before !== undefined &&
        lostGrant(before, after) &&
        (await dependencies.sameDriver(input.source, bundleOf(kept))) &&
        (await dependencies.probe(bundleOf(kept), input.bundleId).then(
          () => true,
          () => false,
        ))
      ) {
        await point("current", kept);
        await point("previous", wanted);
        await point("rejected", wanted);
        return use(
          kept,
          "The updated " +
            COMPUTER_USE_HELPER_NAME +
            " lost an Accessibility or Screen Recording grant the previous one holds, so the previous one keeps running. Grant the new one to move to it.",
        );
      }
    }
    await point("rejected", undefined);
    return use(wanted);
  };

  // One install at a time: a second caller would otherwise prune the first one's directories.
  let queue: Promise<unknown> = Promise.resolve();
  return (input: HelperInstallInput): Promise<HelperInstallResult> => {
    const run = queue.then(() => install(input));
    queue = run.catch(() => undefined);
    return run;
  };
}

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

const helperInstallDependencies: HelperInstallDependencies = {
  signature: async (bundle) => {
    try {
      // codesign -d reports on stderr.
      const { stderr } = await execFile("codesign", ["-d", "--verbose=4", bundle]);
      const field = (name: string) =>
        new RegExp("^" + name + "=(.+)$", "mu").exec(stderr)?.[1]?.trim();
      const cdhash = field("CDHash");
      const team = field("TeamIdentifier");
      return cdhash ? { cdhash, team: team && team !== "not set" ? team : undefined } : undefined;
    } catch {
      return undefined;
    }
  },
  satisfies: (bundle, requirement) =>
    execFile("codesign", ["--verify", "--strict", "--deep", "-R=" + requirement, bundle]).then(
      () => true,
      () => false,
    ),
  // ditto keeps the bundle's layout and signature; dropping extended attributes keeps a
  // provenance or quarantine mark from following the copy to its new path.
  copy: async (from, to) => {
    await execFile("ditto", ["--noextattr", "--noqtn", from, to]);
  },
  sameDriver: async (bundle, other) => {
    const digest = async (path: string) =>
      NodeCrypto.createHash("sha256")
        .update(await NodeFSP.readFile(helperBundle(path, "").driverPath))
        .digest("hex");
    return (await digest(bundle)) === (await digest(other).catch(() => ""));
  },
  probe: async (bundle, bundleId) => {
    const session = await openHelperSession(
      spawnHelperProcess(helperBundle(bundle, bundleId).executable, "darwin"),
      bundleId,
    );
    await session.close();
  },
  grants: (bundle, bundleId) =>
    probeHelperGrants(
      spawnHelperProcess(helperBundle(bundle, bundleId).executable, "darwin"),
      bundleId,
      false,
    ),
};

const install = makeHelperInstaller(helperInstallDependencies);

/**
 * The helper bundle a build runs. Packaged Mac builds run the installed generation of the helper
 * in Contents/Helpers; dev builds run GOAT_CUA_HELPER_PATH in place.
 */
export async function resolveHelperBundle(input: {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly platform: NodeJS.Platform;
  readonly stateDir: string;
  readonly bundleId: string;
  readonly busy: boolean;
}): Promise<HelperInstallResult | { readonly kind: "absent" }> {
  const configured = input.isPackaged ? undefined : process.env.GOAT_CUA_HELPER_PATH?.trim();
  if (!input.isPackaged && !configured) return { kind: "absent" };
  // A set dev path must exist; only a packaged build with nothing at the helper's place falls back.
  if (input.platform === "win32")
    return classifyHelperBundle(
      configured || NodePath.join(input.resourcesPath, "computer-use-helper"),
      configured !== undefined,
      (path) => windowsHelperBundle(path, "").executable,
    );
  const found = await classifyHelperBundle(
    configured || NodePath.join(input.resourcesPath, "..", "Helpers", HELPER_APP),
    configured !== undefined,
  );
  if (found.kind !== "found" || !input.isPackaged) return found;
  return install({
    app: NodePath.resolve(input.resourcesPath, "..", ".."),
    source: found.path,
    bundleId: input.bundleId,
    root: NodePath.join(input.stateDir, "computer-use-helper"),
    busy: input.busy,
  }).catch((error: unknown) => ({
    kind: "found" as const,
    path: found.path,
    note:
      "Running " +
      COMPUTER_USE_HELPER_NAME +
      " from GOAT.app; installing it failed (" +
      ((error as NodeJS.ErrnoException).code ?? String(error)) +
      ").",
  }));
}

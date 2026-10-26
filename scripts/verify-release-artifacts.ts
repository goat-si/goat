#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { Command, Flag } from "effect/cli";
import {
  assembleRelease,
  releaseAssetKey,
  releaseAssetVersion,
  releaseInputs,
  ReleaseVerificationError,
  requireReleaseCommand,
  runReleaseCommand,
  scanBuildLinks,
  scanReleasePayload,
  unpackReleaseArchive,
  walkReleaseTree,
  writeReleaseReport,
  type ReleaseCommandRunner,
  type ReleaseReport,
} from "./lib/release-verify.ts";

export const verifyMacPayload = Effect.fn("verifyMacPayload")(function* (
  root: string,
  team: string,
  requireSigning: boolean,
  runner: ReleaseCommandRunner = runReleaseCommand,
) {
  const problems: string[] = [];
  const checks: string[] = [];
  const entries = yield* walkReleaseTree(root);
  let binaries = 0;
  let apps = 0;
  const check = Effect.fn("checkMacSignature")(function* (
    program: string,
    args: readonly string[],
    label: string,
    teamCheck = false,
  ) {
    const result = yield* runner(program, args);
    const output = result.stdout + result.stderr;
    const ok =
      result.exitCode === 0 &&
      (!teamCheck ||
        output.split(/\r?\n/).some((line) => line.trim() === `TeamIdentifier=${team}`));
    if (ok) checks.push(label);
    else if (requireSigning)
      problems.push(`${label}: ${output.trim() || `exit ${result.exitCode}`}`);
    else checks.push(`unsigned/unverified: ${label}`);
  });
  for (const entry of entries) {
    if (entry.type === "directory" && entry.relative.endsWith(".app")) {
      apps++;
      yield* check(
        "codesign",
        ["--verify", "--deep", "--strict", entry.absolute],
        `app signature ${entry.relative}`,
      );
      yield* check(
        "spctl",
        ["-a", "-vv", "-t", "exec", entry.absolute],
        `app Gatekeeper ${entry.relative}`,
      );
      // The notarization ticket is stapled to the outermost app; Electron's nested
      // helper apps are covered by it and never carry their own.
      if (!/\.app[\\/]/.test(entry.relative))
        yield* check(
          "xcrun",
          ["stapler", "validate", entry.absolute],
          `app staple ${entry.relative}`,
        );
    }
  }
  const visitMachO = Effect.fn("verifyMacBinary")(function* (file: string, name: string) {
    binaries++;
    yield* check("codesign", ["--verify", "--strict", file], `Mach-O signature ${name}`);
    yield* check("codesign", ["-dvv", file], `Mach-O team ${name}`, true);
  });
  problems.push(...(yield* scanReleasePayload(root, runner, visitMachO)));
  if (!binaries) problems.push("Mac payload contains no Mach-O binaries");
  checks.push(`structure: ${apps} apps, ${binaries} Mach-O files`, "exposure-scan");
  return { problems, checks, apps };
});
export const verifyReleaseDirectory = Effect.fn("verifyReleaseDirectory")(function* (
  options: {
    mode: "payload" | "mac";
    dir: string;
    report: string;
    team?: string;
    requireSigning?: boolean;
    version?: string | undefined;
    key?: string | undefined;
  },
  runner: ReleaseCommandRunner = runReleaseCommand,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const inputs = yield* releaseInputs(options.dir);
  const keys = [...new Set(inputs.map((input) => releaseAssetKey(input.name)))];
  const versions = [...new Set(inputs.map((input) => releaseAssetVersion(input.name)))];
  const problems: string[] = [];
  const checks = ["payload-hashes"];
  if (options.mode === "mac" && options.requireSigning) checks.push("require-signing");
  const key = options.key ?? keys[0] ?? "unknown";
  const version = options.version ?? versions[0] ?? "unknown";
  if (
    !inputs.length ||
    keys.length !== 1 ||
    keys[0] !== key ||
    versions.length !== 1 ||
    versions[0] !== version
  )
    problems.push("expected artifacts from one build key and version");
  if (
    options.mode === "mac" &&
    options.requireSigning &&
    !/^[A-Z0-9]{10}$/.test(options.team ?? "")
  )
    problems.push("signing verification requires --team <10-character team ID>");
  for (const input of inputs) {
    const archive = path.resolve(options.dir, input.name);
    const verify = Effect.gen(function* () {
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "goat-verify-" });
      const root = path.join(temp, "payload");
      yield* fs.makeDirectory(root);
      const inspect = Effect.gen(function* () {
        if (options.mode === "mac") {
          const verified = yield* verifyMacPayload(
            root,
            options.team ?? "",
            options.requireSigning ?? false,
            runner,
          );
          problems.push(...verified.problems.map((problem) => `${input.name}: ${problem}`));
          checks.push(...verified.checks.map((check) => `${input.name}: ${check}`));
          if (key.startsWith("desktop-") && !verified.apps)
            problems.push(`${input.name}: missing .app bundle`);
        } else {
          problems.push(
            ...(yield* scanReleasePayload(root, runner)).map(
              (problem) => `${input.name}: ${problem}`,
            ),
          );
          checks.push(`${input.name}: exposure-scan`);
        }
      });
      if (options.mode === "mac" && input.name.endsWith(".dmg")) {
        const mounted = Effect.gen(function* () {
          yield* requireReleaseCommand(runner, "hdiutil", [
            "attach",
            "-nobrowse",
            "-readonly",
            "-mountpoint",
            root,
            archive,
          ]);
          for (const [program, args] of [
            ["codesign", ["--verify", archive]],
            [
              "spctl",
              ["-a", "-vv", "-t", "open", "--context", "context:primary-signature", archive],
            ],
            ["xcrun", ["stapler", "validate", archive]],
          ] as const) {
            const result = yield* runner(program, args);
            if (result.exitCode !== 0 && options.requireSigning)
              problems.push(`${input.name}: ${program} verification failed: ${result.stderr}`);
            else
              checks.push(
                `${input.name}: ${result.exitCode === 0 ? "verified" : "unsigned/unverified"} ${program}`,
              );
          }
          yield* inspect;
        });
        // Detach even if attach partially succeeds, inspection fails or the fiber is interrupted.
        yield* mounted.pipe(
          Effect.ensuring(
            requireReleaseCommand(runner, "hdiutil", ["detach", root]).pipe(
              Effect.catch((error) =>
                Effect.sync(() => {
                  problems.push(`${input.name}: detach failed: ${String(error)}`);
                }),
              ),
            ),
          ),
        );
      } else if (/\.(?:zip|tar\.gz)$/.test(input.name)) {
        yield* unpackReleaseArchive(archive, root, runner, options.mode === "mac");
        yield* inspect;
      } else problems.push(`${input.name}: unsupported ${options.mode} container`);
    }).pipe(Effect.scoped);
    yield* verify.pipe(
      Effect.catch((error) => Effect.sync(() => problems.push(`${input.name}: ${String(error)}`))),
    );
  }
  const report: ReleaseReport = {
    key,
    mode: options.mode,
    version,
    inputs: inputs.map(({ name, sha256 }) => ({ name, sha256 })),
    ok: problems.length === 0,
    checks,
    problems,
  };
  yield* writeReleaseReport(options.report, report);
  if (problems.length) return yield* new ReleaseVerificationError({ problems });
  return report;
});
const common = {
  dir: Flag.String("dir"),
  report: Flag.String("report"),
  version: Flag.String("version").pipe(Flag.optional),
  key: Flag.String("key").pipe(Flag.optional),
};
const payload = Command.make("payload", common, ({ dir, report, version, key }) =>
  verifyReleaseDirectory({
    mode: "payload",
    dir,
    report,
    version: Option.getOrUndefined(version),
    key: Option.getOrUndefined(key),
  }),
);
const mac = Command.make(
  "mac",
  {
    ...common,
    team: Flag.String("team"),
    requireSigning: Flag.Boolean("require-signing").pipe(Flag.withDefault(false)),
  },
  ({ dir, report, version, key, team, requireSigning }) =>
    verifyReleaseDirectory({
      mode: "mac",
      dir,
      report,
      team,
      requireSigning,
      version: Option.getOrUndefined(version),
      key: Option.getOrUndefined(key),
    }),
);
const assemble = Command.make(
  "assemble",
  {
    dir: Flag.String("dir"),
    reports: Flag.String("reports"),
    version: Flag.String("version"),
    allowMissing: Flag.String("allow-missing").pipe(Flag.atLeast(0)),
    report: Flag.String("report").pipe(Flag.optional),
  },
  ({ dir, reports, version, allowMissing, report }) =>
    Effect.gen(function* () {
      const result = yield* assembleRelease(dir, reports, version, allowMissing);
      if (Option.isSome(report)) yield* writeReleaseReport(report.value, result);
      yield* Effect.log("Release assets verified; SHA256SUMS written and re-read.");
    }),
);
const links = Command.make("links", { dir: Flag.String("dir").pipe(Flag.atLeast(1)) }, ({ dir }) =>
  Effect.gen(function* () {
    const problems = yield* scanBuildLinks(dir);
    if (problems.length) return yield* new ReleaseVerificationError({ problems });
    yield* Effect.log(`No private repository URLs in ${dir.join(", ")}.`);
  }),
);
const command = Command.make("verify-release-artifacts").pipe(
  Command.withSubcommands([payload, mac, assemble, links]),
);
if (import.meta.main)
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );

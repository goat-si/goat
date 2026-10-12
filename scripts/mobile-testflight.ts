#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Host-side Xcode automation uses Node subprocess and file APIs directly.
/**
 * Builds the GOAT iOS app on this Mac and uploads it to TestFlight.
 *
 *   node scripts/mobile-testflight.ts                 # production archive + upload
 *   node scripts/mobile-testflight.ts --variant preview
 *   node scripts/mobile-testflight.ts --simulator     # unsigned simulator Release build only
 *   node scripts/mobile-testflight.ts --export-only   # signed IPA, no upload
 *   node scripts/mobile-testflight.ts --dry-run       # print the commands
 *
 * Signing is automatic for the GOAT team (GOAT_IOS_TEAM_ID, default U9ATA49N28). Xcode needs an
 * Apple account for that team (Xcode > Settings > Accounts), or an App Store Connect API key in
 * ASC_KEY_PATH, ASC_KEY_ID and ASC_ISSUER_ID. See docs/operations/mobile-testflight.md.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

import {
  DEFAULT_IOS_TEAM_ID,
  MOBILE_APP_IDENTITY,
  type MobileAppVariant,
} from "@t3tools/shared/mobileAppIdentity";

import { loadRepoEnv } from "./lib/public-config.ts";

const REPO_ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const MOBILE_ROOT = NodePath.join(REPO_ROOT, "apps/mobile");

interface Options {
  readonly variant: Exclude<MobileAppVariant, "development">;
  readonly buildNumber: string;
  readonly mode: "upload" | "export" | "simulator";
  readonly dryRun: boolean;
}

function fail(message: string): never {
  NodeProcess.stderr.write(`\nmobile-testflight: ${message}\n`);
  NodeProcess.exit(1);
}

export function parseOptions(argv: ReadonlyArray<string>, now = Date.now()): Options {
  let variant: Options["variant"] = "production";
  // Minutes since the epoch: increases across runs and stays far below store limits. Two runs in
  // the same minute get the same number, so pass a higher --build-number to retry an upload.
  let buildNumber = String(Math.floor(now / 60_000));
  let mode: Options["mode"] = "upload";
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--variant") {
      const value = argv[++index];
      if (value !== "production" && value !== "preview") {
        throw new Error("--variant must be production or preview.");
      }
      variant = value;
    } else if (arg === "--build-number") {
      const value = argv[++index] ?? "";
      if (!/^[1-9][0-9]*$/.test(value))
        throw new Error("--build-number must be a positive integer.");
      buildNumber = value;
    } else if (arg === "--simulator") {
      mode = "simulator";
    } else if (arg === "--export-only") {
      mode = "export";
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else {
      throw new Error(`Unknown argument ${arg}.`);
    }
  }
  return { variant, buildNumber, mode, dryRun };
}

/** The xcodebuild flags that authenticate with an App Store Connect API key, if one is configured. */
export function apiKeyArgs(environment: NodeJS.ProcessEnv): ReadonlyArray<string> | null {
  const path = environment.ASC_KEY_PATH?.trim();
  const id = environment.ASC_KEY_ID?.trim();
  const issuer = environment.ASC_ISSUER_ID?.trim();
  if (!path && !id && !issuer) return null;
  if (!path || !id || !issuer) {
    throw new Error("Set all of ASC_KEY_PATH, ASC_KEY_ID and ASC_ISSUER_ID, or none of them.");
  }
  return [
    "-authenticationKeyPath",
    path,
    "-authenticationKeyID",
    id,
    "-authenticationKeyIssuerID",
    issuer,
  ];
}

export function exportOptionsPlist(input: {
  readonly teamId: string;
  readonly destination: "upload" | "export";
}): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>method</key><string>app-store-connect</string>",
    `  <key>destination</key><string>${input.destination}</string>`,
    `  <key>teamID</key><string>${input.teamId}</string>`,
    "  <key>signingStyle</key><string>automatic</string>",
    // The build number is chosen here and baked into the widget at prebuild; Xcode must not change it.
    "  <key>manageAppVersionAndBuildNumber</key><false/>",
    "  <key>uploadSymbols</key><true/>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function hasXcodeAccountForTeam(teamId: string): boolean {
  const result = NodeChildProcess.spawnSync(
    "defaults",
    ["read", "com.apple.dt.Xcode", "IDEProvisioningTeamByIdentifier"],
    { encoding: "utf8" },
  );
  return result.status === 0 && result.stdout.includes(teamId);
}

function run(
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly dryRun: boolean },
): void {
  NodeProcess.stdout.write(`\n$ ${command} ${args.join(" ")}\n`);
  if (options.dryRun) return;
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    fail(`${command} exited with ${result.status ?? result.signal}.`);
  }
}

function plistValue(file: string, key: string): string | null {
  const result = NodeChildProcess.spawnSync(
    "/usr/libexec/PlistBuddy",
    ["-c", `Print :${key}`, file],
    { encoding: "utf8" },
  );
  return result.status === 0 ? result.stdout.trim() : null;
}

export interface ArchiveFacts {
  /** The app first, then each extension, as read from their Info.plist files. */
  readonly bundles: ReadonlyArray<{
    readonly name: string;
    readonly bundleId: string | null;
    readonly version: string | null;
  }>;
  /** The Expo config embedded in the app, or null when it is missing. */
  readonly embedded: {
    readonly name?: unknown;
    readonly scheme?: unknown;
    readonly ios?: { readonly bundleIdentifier?: unknown };
  } | null;
}

/** What is wrong with an archive for this variant and build number; empty when it matches. */
export function archiveProblems(
  facts: ArchiveFacts,
  expected: {
    readonly appName: string;
    readonly scheme: string;
    readonly bundleId: string;
    readonly buildNumber: string;
  },
): ReadonlyArray<string> {
  const problems: Array<string> = [];
  const [app, ...extensions] = facts.bundles;
  if (app?.bundleId !== expected.bundleId) problems.push(`app bundle id is ${app?.bundleId}`);
  for (const extension of extensions) {
    if (!extension.bundleId?.startsWith(`${expected.bundleId}.`)) {
      problems.push(`${extension.name} bundle id is ${extension.bundleId}`);
    }
  }
  for (const bundle of facts.bundles) {
    if (bundle.version !== expected.buildNumber) {
      problems.push(`${bundle.name} has build ${bundle.version}`);
    }
  }
  const embedded = facts.embedded;
  if (embedded === null) {
    problems.push("the app has no embedded Expo config");
  } else {
    if (embedded.name !== expected.appName)
      problems.push(`embedded name is ${String(embedded.name)}`);
    if (embedded.scheme !== expected.scheme) {
      problems.push(`embedded scheme is ${String(embedded.scheme)}`);
    }
    if (embedded.ios?.bundleIdentifier !== expected.bundleId) {
      problems.push(`embedded bundle id is ${String(embedded.ios?.bundleIdentifier)}`);
    }
  }
  return problems;
}

function readArchiveFacts(archivePath: string, xcodeName: string): ArchiveFacts {
  const app = NodePath.join(archivePath, "Products/Applications", `${xcodeName}.app`);
  const paths = [app];
  const plugIns = NodePath.join(app, "PlugIns");
  if (NodeFS.existsSync(plugIns)) {
    for (const entry of NodeFS.readdirSync(plugIns).sort())
      paths.push(NodePath.join(plugIns, entry));
  }
  const embeddedPath = NodePath.join(app, "EXConstants.bundle/app.config");
  return {
    bundles: paths.map((bundle) => ({
      name: NodePath.basename(bundle),
      bundleId: plistValue(NodePath.join(bundle, "Info.plist"), "CFBundleIdentifier"),
      version: plistValue(NodePath.join(bundle, "Info.plist"), "CFBundleVersion"),
    })),
    embedded: NodeFS.existsSync(embeddedPath)
      ? (JSON.parse(NodeFS.readFileSync(embeddedPath, "utf8")) as ArchiveFacts["embedded"])
      : null,
  };
}

/** Stops before upload unless the archive carries this variant's identity and build number. */
function verifyArchive(input: {
  readonly archivePath: string;
  readonly xcodeName: string;
  readonly bundleId: string;
  readonly appName: string;
  readonly scheme: string;
  readonly buildNumber: string;
}): void {
  const facts = readArchiveFacts(input.archivePath, input.xcodeName);
  const problems = archiveProblems(facts, input);
  if (problems.length > 0) {
    fail(
      `archive does not match ${input.appName} build ${input.buildNumber}: ${problems.join("; ")}.`,
    );
  }
  NodeProcess.stdout.write(
    `\nVerified ${input.appName} (${input.bundleId}) build ${input.buildNumber} in ${facts.bundles.length} bundle(s).\n`,
  );
}

function main(): void {
  // The same .env and .env.local app.config.ts reads, so the team and key match prebuild's.
  const repoEnv: NodeJS.ProcessEnv = loadRepoEnv();
  let options: Options;
  let keyArgs: ReadonlyArray<string> | null;
  try {
    options = parseOptions(NodeProcess.argv.slice(2));
    keyArgs = apiKeyArgs(repoEnv);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (NodeProcess.platform !== "darwin") fail("iOS builds need macOS with Xcode.");
  const identity = MOBILE_APP_IDENTITY[options.variant];
  const teamId = repoEnv.GOAT_IOS_TEAM_ID?.trim() || DEFAULT_IOS_TEAM_ID;
  const signed = options.mode !== "simulator";
  if (signed && !options.dryRun && keyArgs === null && !hasXcodeAccountForTeam(teamId)) {
    fail(
      `Xcode has no Apple account for team ${teamId}. Sign in under Xcode > Settings > Accounts, or set ASC_KEY_PATH, ASC_KEY_ID and ASC_ISSUER_ID.`,
    );
  }

  // Xcode's build phases evaluate app.config.ts again (expo-constants, expo-updates), so every
  // step gets the same variant and build number as prebuild.
  const env: NodeJS.ProcessEnv = {
    ...repoEnv,
    APP_VARIANT: options.variant,
    GOAT_MOBILE_BUILD_NUMBER: options.buildNumber,
    EXPO_NO_GIT_STATUS: "1",
  };
  const output = NodePath.join(
    MOBILE_ROOT,
    ".testflight",
    `${options.variant}-${options.buildNumber}`,
  );
  const workspace = NodePath.join(MOBILE_ROOT, "ios", `${identity.xcodeName}.xcworkspace`);
  if (!options.dryRun) NodeFS.mkdirSync(output, { recursive: true });
  const at = { cwd: MOBILE_ROOT, env, dryRun: options.dryRun };

  run(
    NodePath.join(MOBILE_ROOT, "node_modules/.bin/expo"),
    ["prebuild", "--clean", "--platform", "ios"],
    at,
  );

  if (options.mode === "simulator") {
    run(
      "xcodebuild",
      [
        "-workspace",
        workspace,
        "-scheme",
        identity.xcodeName,
        "-configuration",
        "Release",
        "-sdk",
        "iphonesimulator",
        "-destination",
        "generic/platform=iOS Simulator",
        "-derivedDataPath",
        NodePath.join(output, "DerivedData"),
        // The vendored GhosttyKit simulator slice is arm64 only.
        "ARCHS=arm64",
        "CODE_SIGNING_ALLOWED=NO",
        "build",
      ],
      at,
    );
    NodeProcess.stdout.write(`\nSimulator Release build of ${identity.appName} finished.\n`);
    return;
  }

  const archivePath = NodePath.join(output, `${identity.xcodeName}.xcarchive`);
  const signing = [
    "-allowProvisioningUpdates",
    // Automatic signing archives with a development profile first, and Apple creates one only for
    // a team with a registered iPhone. This registers an iPhone connected to the Mac.
    "-allowProvisioningDeviceRegistration",
    ...(keyArgs ?? []),
    `DEVELOPMENT_TEAM=${teamId}`,
    "CODE_SIGN_STYLE=Automatic",
    `CURRENT_PROJECT_VERSION=${options.buildNumber}`,
  ];
  run(
    "xcodebuild",
    [
      "-workspace",
      workspace,
      "-scheme",
      identity.xcodeName,
      "-configuration",
      "Release",
      "-destination",
      "generic/platform=iOS",
      "-archivePath",
      archivePath,
      ...signing,
      "archive",
    ],
    at,
  );
  if (!options.dryRun) {
    verifyArchive({
      archivePath,
      xcodeName: identity.xcodeName,
      bundleId: identity.iosBundleIdentifier,
      appName: identity.appName,
      scheme: identity.scheme,
      buildNumber: options.buildNumber,
    });
  }

  const destination = options.mode === "upload" ? "upload" : "export";
  const plistPath = NodePath.join(output, "ExportOptions.plist");
  if (!options.dryRun) {
    NodeFS.writeFileSync(plistPath, exportOptionsPlist({ teamId, destination }));
  }
  run(
    "xcodebuild",
    [
      "-exportArchive",
      "-archivePath",
      archivePath,
      "-exportOptionsPlist",
      plistPath,
      "-exportPath",
      NodePath.join(output, "export"),
      "-allowProvisioningUpdates",
      ...(keyArgs ?? []),
    ],
    at,
  );
  if (options.dryRun) return;
  NodeProcess.stdout.write(
    destination === "upload"
      ? `\nUploaded ${identity.appName} build ${options.buildNumber}. It appears in TestFlight after App Store Connect finishes processing.\n`
      : `\nExported ${identity.appName} build ${options.buildNumber} to ${NodePath.join(output, "export")}.\n`,
  );
}

if (import.meta.main) main();

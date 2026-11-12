// @effect-diagnostics-next-line nodeBuiltinImport:off -- exercises real directory search permission.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- builds a native permission-test fixture path.
import * as NodePath from "node:path";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import type { ModelCapabilities } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import { createModelCapabilities } from "@goat/shared/model";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  classifySpawnFailure,
  collectStreamAsString,
  isCommandMissingCause,
  isMissingMiseToolResult,
  isMissingProbeToolResult,
  parseCliVersionResult,
  providerProbeEnvironment,
  parseGenericCliVersion,
  ProviderCommandNotFoundError,
  providerModelsFromSettings,
  spawnAndCollect,
} from "./snapshotProbe.ts";

it("keeps mise offline for probes and never treats its error version as the CLI version", () => {
  const environment = { PATH: "/bin", MISE_OFFLINE: "0" };
  expect(providerProbeEnvironment(environment)).toEqual({
    PATH: "/bin",
    MISE_OFFLINE: "1",
    MISE_AUTO_INSTALL: "0",
    MISE_NOT_FOUND_AUTO_INSTALL: "0",
    npm_config_offline: "true",
    NPM_CONFIG_OFFLINE: "true",
    UV_OFFLINE: "1",
    COREPACK_ENABLE_NETWORK: "0",
  });
  expect(environment.MISE_OFFLINE).toBe("0");
  const result = {
    code: 1,
    stdout: "",
    stderr: "mise ERROR Failed to install tool: no versions found\nmise Version: 2026.11.5",
  };
  expect(isMissingMiseToolResult(result)).toBe(true);
  expect(parseCliVersionResult(result)).toBeNull();
  expect(isMissingMiseToolResult({ ...result, code: 0 })).toBe(false);
  expect(isMissingMiseToolResult({ code: 1, stdout: "", stderr: "tool reported an error" })).toBe(
    false,
  );
  expect(
    isMissingMiseToolResult({
      code: 1,
      stdout: "",
      stderr: "mise ERROR No version is set for shim: claude",
    }),
  ).toBe(true);
  expect(
    isMissingProbeToolResult({ code: 1, stdout: "", stderr: "npm error code ENOTCACHED" }),
  ).toBe(true);
  expect(
    isMissingProbeToolResult({
      code: 1,
      stdout: "",
      stderr: "corepack: network access is disabled",
    }),
  ).toBe(true);
});

describe("spawn failure diagnosis", () => {
  it("reports a deleted inherited cwd as inaccessible after a spawn failure (#2476)", () => {
    expect(
      classifySpawnFailure({ code: "ENOENT" }, undefined, undefined, undefined, undefined, () => {
        throw Object.assign(new Error("cwd deleted"), { code: "ENOENT" });
      }),
    ).toBe("cwd_inaccessible");
  });

  it.effect("a spawn failure with no cwd keeps its real cause (#2415)", () =>
    Effect.sync(() => {
      const missing = { binary: NodePath.join(NodeOS.tmpdir(), "goat-no-such-binary-2415") };
      const existing = { binary: process.execPath };
      expect([
        classifySpawnFailure({ code: "ENOENT" }, undefined, undefined, missing),
        classifySpawnFailure({ code: "ENOENT" }, undefined, undefined, existing),
        classifySpawnFailure({ code: "EACCES" }, undefined, undefined, existing),
        classifySpawnFailure({ code: "EPERM" }, undefined, undefined, existing),
        classifySpawnFailure({ code: "EIO" }, undefined),
      ]).toEqual(["missing", "unknown", "unknown", "unknown", "unknown"]);
    }),
  );

  it.effect("does not report a missing binary when its path cannot be inspected (#2415)", () =>
    Effect.sync(() => {
      for (const code of ["EACCES", "EIO"]) {
        expect(
          classifySpawnFailure(
            { code: "ENOENT" },
            undefined,
            undefined,
            { binary: NodePath.join(NodeOS.tmpdir(), "provider-cli") },
            () => {
              throw Object.assign(new Error("stat failed"), { code });
            },
          ),
        ).toBe("unknown");
      }
      for (const code of ["ENOENT", "ENOTDIR"]) {
        expect(
          classifySpawnFailure(
            { code: "ENOENT" },
            undefined,
            undefined,
            { binary: "provider-cli", env: { PATH: NodeOS.tmpdir() } },
            () => {
              throw Object.assign(new Error("stat failed"), { code });
            },
          ),
        ).toBe("missing");
      }
      const cwd = process.cwd();
      expect(
        classifySpawnFailure(
          { code: "ENOENT" },
          cwd,
          undefined,
          {
            binary: "provider-cli",
            env: { PATH: [cwd, NodeOS.tmpdir()].join(NodePath.delimiter) },
          },
          (path) => {
            if (path === NodePath.join(cwd, "provider-cli")) {
              throw Object.assign(new Error("stat failed"), { code: "EIO" });
            }
            return true;
          },
        ),
      ).toBe("exec_failed");
    }),
  );

  it.effect("keeps an inaccessible executable unknown even when cwd is known (#2415)", () =>
    Effect.sync(() => {
      expect(
        classifySpawnFailure(
          { code: "ENOENT" },
          process.cwd(),
          undefined,
          { binary: "provider-cli", env: { PATH: NodeOS.tmpdir() } },
          () => {
            throw Object.assign(new Error("stat failed"), { code: "EACCES" });
          },
        ),
      ).toBe("unknown");
    }),
  );

  it("recognizes an existing executable with a missing interpreter, including PATH lookup", () => {
    const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-broken-shebang-"));
    try {
      const binary = NodePath.join(cwd, "broken");
      NodeFS.writeFileSync(binary, "#!/nonexistent/interpreter\n", { mode: 0o755 });
      for (const name of [binary, "./broken", "broken"]) {
        expect(
          classifySpawnFailure({ code: "ENOENT" }, cwd, undefined, {
            binary: name,
            env: { PATH: cwd },
          }),
        ).toBe("exec_failed");
      }
    } finally {
      NodeFS.rmSync(cwd, { recursive: true });
    }
  });
  it("recognizes a directory without search permission", () => {
    const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-spawn-permission-"));
    try {
      NodeFS.chmodSync(cwd, 0o000);
      if (process.getuid?.() === 0) {
        expect(
          classifySpawnFailure({ code: "EACCES" }, cwd, () => {
            throw Object.assign(new Error("injected access failure"), { code: "EACCES" });
          }),
        ).toBe("cwd_inaccessible");
      } else {
        expect(classifySpawnFailure({ code: "EACCES" }, cwd)).toBe("cwd_inaccessible");
      }
    } finally {
      NodeFS.chmodSync(cwd, 0o700);
      NodeFS.rmdirSync(cwd);
    }
  });
  it("distinguishes a missing executable from a missing working directory through nested causes", () => {
    const failure = { cause: { cause: { code: "ENOENT" } } };
    expect(classifySpawnFailure(failure, process.cwd())).toBe("missing");
    expect(classifySpawnFailure(failure, "/goat-test-nonexistent-cwd-2819393")).toBe(
      "cwd_inaccessible",
    );
  });

  it("distinguishes executable permission from an unsearchable working directory", () => {
    const failure = { cause: { code: "EACCES" } };
    expect(classifySpawnFailure(failure, process.cwd())).toBe("permission_denied");
    expect(classifySpawnFailure(failure, "/goat-test-nonexistent-cwd-2819393")).toBe(
      "cwd_inaccessible",
    );
    expect(classifySpawnFailure({ code: "EPERM" }, process.cwd())).toBe("permission_denied");
    expect(classifySpawnFailure({ code: "ENOTDIR" }, "/goat-test-nonexistent-cwd-2819393")).toBe(
      "cwd_inaccessible",
    );
    expect(classifySpawnFailure({ code: "EIO" }, process.cwd())).toBe("unknown");
  });

  it("preserves Windows command-not-found evidence", () => {
    const error = new ProviderCommandNotFoundError({
      binaryPath: "codex.cmd",
      exitCode: 9009,
      stdoutLength: 0,
      stderrLength: 0,
    });
    expect(classifySpawnFailure({ cause: error }, process.cwd())).toBe("missing");
  });
});

const OPENCODE_CUSTOM_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "variant",
      label: "Reasoning",
      type: "select",
      options: [{ id: "medium", label: "Medium", isDefault: true }],
      currentValue: "medium",
    },
    {
      id: "agent",
      label: "Agent",
      type: "select",
      options: [{ id: "build", label: "Build", isDefault: true }],
      currentValue: "build",
    },
  ],
});

describe("providerModelsFromSettings", () => {
  it("keeps an entry's own name and capabilities over the driver default", () => {
    const capabilities = createModelCapabilities({
      optionDescriptors: [{ id: "fastMode", label: "Fast Mode", type: "boolean" }],
    });
    const models = providerModelsFromSettings(
      [],
      ["bare", { slug: "named", name: "Named", capabilities }],
      OPENCODE_CUSTOM_MODEL_CAPABILITIES,
    );

    expect(models).toEqual([
      {
        slug: "bare",
        name: "bare",
        isCustom: true,
        capabilities: OPENCODE_CUSTOM_MODEL_CAPABILITIES,
      },
      { slug: "named", name: "Named", isCustom: true, capabilities },
    ]);
  });

  it("renames a built-in model when a named entry uses its slug", () => {
    const capabilities = createModelCapabilities({ optionDescriptors: [] });
    const models = providerModelsFromSettings(
      [
        {
          slug: "gpt-5.5",
          name: "GPT-5.5",
          shortName: "5.5",
          isCustom: false,
          capabilities,
        },
      ],
      [{ slug: "gpt-5.5", name: "Team GPT" }],
      capabilities,
    );

    expect(models).toEqual([{ slug: "gpt-5.5", name: "Team GPT", isCustom: false, capabilities }]);
  });

  it("preserves a custom slug that collides with a provider alias", () => {
    const capabilities = createModelCapabilities({ optionDescriptors: [] });
    const models = providerModelsFromSettings(
      [
        {
          slug: "claude-opus-4-8",
          name: "Claude Opus 4.8",
          isCustom: false,
          capabilities,
        },
      ],
      [" opus "],
      capabilities,
    );

    expect(models.map((model) => model.slug)).toEqual(["claude-opus-4-8", "opus"]);
    expect(models[1]?.isCustom).toBe(true);
  });
});

describe("parseGenericCliVersion", () => {
  it("parses a v-prefixed version", () => {
    expect(parseGenericCliVersion("opencode v2.0.3")).toBe("2.0.3");
    expect(parseGenericCliVersion("v22.19.0")).toBe("22.19.0");
    // A pinned install compares the whole version, so a prerelease keeps its suffix.
    expect(parseGenericCliVersion("pi 1.2.3-beta.1")).toBe("1.2.3-beta.1");
    expect(parseGenericCliVersion("opencode v2.0.3-rc.2 (linux)")).toBe("2.0.3-rc.2");
    // SemVer prerelease identifiers may contain hyphens.
    expect(parseGenericCliVersion("opencode 1.2.3-beta-test.1")).toBe("1.2.3-beta-test.1");
    expect(parseGenericCliVersion("pi 1.2.3-beta-")).toBe("1.2.3-beta-");
    expect(parseGenericCliVersion("version 1.2.3.")).toBe("1.2.3");
  });

  it("parses a version embedded in other output", () => {
    expect(parseGenericCliVersion("codex-cli 0.53.0 (build abc)")).toBe("0.53.0");
  });

  it("ignores versions glued to other word characters", () => {
    expect(parseGenericCliVersion("build2.0.3artifact")).toBeNull();
    // An underscore joins a token too; the real version later in the output is the one read.
    expect(parseGenericCliVersion("build_1.2.3 pi 1.2.4")).toBe("1.2.4");
    expect(parseGenericCliVersion("1.2.3_artifact pi 1.2.4")).toBe("1.2.4");
  });

  it("keeps build metadata so an exact pin can tell the builds apart", () => {
    expect(parseGenericCliVersion("pi 1.2.3+build.4")).toBe("1.2.3+build.4");
    expect(parseGenericCliVersion("pi 1.2.3-beta+build.4 (linux)")).toBe("1.2.3-beta+build.4");
  });
});

describe("ProviderCommandNotFoundError", () => {
  it.effect("retains safe failed-command diagnostics without process output", () => {
    const stderr = "'codex' is not recognized: secret-token-value";
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(9009)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.encodeText(Stream.make(stderr)),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    );
    return Effect.gen(function* () {
      const error = yield* spawnAndCollect(
        "C:\\tools\\codex.cmd",
        ChildProcess.make("codex", ["--version"]),
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.flip,
      );

      if (error._tag !== "ProviderCommandNotFoundError") {
        throw new Error(`Unexpected error: ${error._tag}`);
      }

      expect(error.binaryPath).toBe("C:\\tools\\codex.cmd");
      expect(error.exitCode).toBe(9009);
      expect(error.stdoutLength).toBe(0);
      expect(error.stderrLength).toBe(stderr.length);
      expect(error.message).toBe(
        "Provider command C:\\tools\\codex.cmd was not found (exit code 9009).",
      );
      expect(isCommandMissingCause(error)).toBe(true);
      expect(error).not.toHaveProperty("stdout");
      expect(error).not.toHaveProperty("stderr");
      expect(error.message).not.toContain("secret-token-value");
    });
  });
});

it.effect("rejects truncated structured output instead of returning a parseable prefix", () =>
  Effect.gen(function* () {
    const bytes = new TextEncoder().encode('{"ok":true}');
    expect(yield* collectStreamAsString(Stream.make(bytes), { maxBytes: bytes.length })).toBe(
      '{"ok":true}',
    );
    const result = yield* collectStreamAsString(
      Stream.make(new TextEncoder().encode('{"ok":true}garbage')),
      { maxBytes: bytes.length },
    ).pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    expect(yield* collectStreamAsString(Stream.make(bytes), { maxBytes: bytes.length })).toBe(
      '{"ok":true}',
    );
  }),
);

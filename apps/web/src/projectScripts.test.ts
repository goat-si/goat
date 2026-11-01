import { legacyEnvName } from "@goat/contracts/legacyT3Names";
import { shortcutLabelForCommand } from "./keybindings";
import { describe, expect, it } from "vite-plus/test";
import {
  projectScriptRuntimeEnv,
  projectScriptMenuLabel,
  settleProjectScript,
  setupProjectScript,
} from "@goat/shared/projectScripts";

import {
  commandForProjectScript,
  nextProjectScriptId,
  primaryProjectScript,
  releaseClaimedRoles,
} from "./projectScripts";

describe("projectScripts helpers", () => {
  it.each(["install-javascript-dependencies", "A", "a.b", "a b", "-a", "", "a".repeat(25)])(
    "omits the shortcut for legacy script ID %j without crashing script menus",
    (id) => {
      const commands = ["lint", id, "test"].map(commandForProjectScript);
      expect(commands).toEqual(["script.lint.run", null, "script.test.run"]);
      expect(commands.map((command) => shortcutLabelForCommand([], command))).toEqual([
        null,
        null,
        null,
      ]);
    },
  );

  it("slugifies and dedupes project script ids", () => {
    expect(nextProjectScriptId("Run Tests", [])).toBe("run-tests");
    expect(nextProjectScriptId("Run Tests", ["run-tests"])).toBe("run-tests-2");
    expect(nextProjectScriptId("!!!", [])).toBe("script");
  });

  it("resolves primary, setup, and settle scripts", () => {
    const scripts = [
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure" as const,
        runOnWorktreeCreate: true,
      },
      {
        id: "clean",
        name: "Clean",
        command: "cargo clean",
        icon: "build" as const,
        runOnWorktreeCreate: false,
        runOnSettle: true,
      },
      {
        id: "test",
        name: "Test",
        command: "bun test",
        icon: "test" as const,
        runOnWorktreeCreate: false,
      },
    ];

    expect(primaryProjectScript(scripts)?.id).toBe("test");
    expect(setupProjectScript(scripts)?.id).toBe("setup");
    expect(settleProjectScript(scripts)?.id).toBe("clean");
    expect(primaryProjectScript(scripts.filter((script) => script.id === "clean"))).toBeNull();
  });

  it("labels every lifecycle role a script runs in", () => {
    const script = {
      id: "both",
      name: "Both",
      command: "true",
      icon: "play" as const,
      runOnWorktreeCreate: true,
    };
    expect(projectScriptMenuLabel(script)).toBe("Both (setup)");
    expect(projectScriptMenuLabel({ ...script, runOnSettle: true })).toBe(
      "Both (setup, on settle)",
    );
    expect(projectScriptMenuLabel({ ...script, runAsCheck: true })).toBe("Both (setup, check)");
    expect(projectScriptMenuLabel({ ...script, runOnWorktreeCreate: false })).toBe("Both");
  });

  it("moves the setup and settle roles to the script that claims them", () => {
    const input = {
      name: "Next",
      command: "true",
      icon: "play",
      waitForSetup: false,
      previewUrl: null,
      autoOpenPreview: false,
    } as const;
    const holder = {
      id: "holder",
      name: "Holder",
      command: "true",
      icon: "play" as const,
      runOnWorktreeCreate: true,
      runOnSettle: true,
      runAsCheck: true,
      checkInSharedCheckout: true,
    };

    expect(
      releaseClaimedRoles(holder, { ...input, runOnWorktreeCreate: false, runOnSettle: true }),
    ).toMatchObject({ runOnWorktreeCreate: true, runOnSettle: false });
    expect(
      releaseClaimedRoles(holder, { ...input, runOnWorktreeCreate: true, runOnSettle: false }),
    ).toMatchObject({ runOnWorktreeCreate: false, runOnSettle: true });
    expect(
      releaseClaimedRoles(holder, { ...input, runOnWorktreeCreate: false, runOnSettle: false }),
    ).toBe(holder);
    expect(
      releaseClaimedRoles(holder, {
        ...input,
        runOnWorktreeCreate: false,
        runOnSettle: false,
        runAsCheck: true,
      }),
    ).toMatchObject({
      runOnWorktreeCreate: true,
      runOnSettle: true,
      runAsCheck: false,
      checkInSharedCheckout: false,
    });
  });

  it("allows overriding runtime env values", () => {
    const env = projectScriptRuntimeEnv({
      project: { cwd: "/repo" },
      extraEnv: {
        GOAT_PROJECT_ROOT: "/custom-root",
        CUSTOM_FLAG: "1",
      },
    });

    expect(env.GOAT_PROJECT_ROOT).toBe("/custom-root");
    expect(env.CUSTOM_FLAG).toBe("1");
    expect(env.GOAT_WORKTREE_PATH).toBeUndefined();
    // Scripts written before the GOAT rename read the legacy name, overrides included.
    expect(env[legacyEnvName("GOAT_PROJECT_ROOT")!]).toBe("/custom-root");
  });
});

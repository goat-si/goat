import { assert, it } from "@effect/vitest";

import { exposureProblems } from "../../../../scripts/lib/release-verify.ts";

import {
  buildTriageContext,
  buildTriageLaunchPrompt,
  buildTriageSeedPrompt,
  TRIAGE_PLAYBOOK,
} from "./triagePrompt.ts";

it("bundles triage instructions without exposing the private source repository", () => {
  assert.deepEqual(exposureProblems("triage-playbook.md", TRIAGE_PLAYBOOK), []);
  assert.deepEqual(exposureProblems("triage-seed.md", buildTriageSeedPrompt("context.md")), []);
  assert.include(TRIAGE_PLAYBOOK, "# GOAT triage playbook");
  assert.notInclude(TRIAGE_PLAYBOOK, "pingdotgg/t3code");
  assert.notInclude(TRIAGE_PLAYBOOK, "npx t3");
});

it("launch prompt stays a single argv-safe line naming the prompt file", () => {
  // The launch argument goes through cmd.exe on Windows (.cmd shims), which
  // cannot carry newlines; the playbook itself must stay on disk.
  const launch = buildTriageLaunchPrompt(String.raw`C:\Users\a b\.t3\userdata\triage\x\prompt.md`);
  assert.notInclude(launch, "\n");
  assert.include(launch, String.raw`C:\Users\a b\.t3\userdata\triage\x\prompt.md`);
  assert.isBelow(launch.length, 1_000);
});

it("context file labels the CLI version as the CLI's, not the user's build", () => {
  // `npx t3 triage` can resolve a different `t3` than the app the bug
  // happened on (#13337), so the agent must not read it as the user's version.
  const context = buildTriageContext({
    generatedAt: "2026-09-24T00:00:00.000Z",
    cliVersion: "0.0.42",
    os: "linux x64 (7.2.0)",
    nodeVersion: "v26.8.2",
    launchedAs: "npx t3 triage",
    server: "running (pid 42, http://127.0.0.1:3773, version 0.0.43-nightly.20260923.2173)",
    paths: {
      stateDir: "/home/u/.t3/userdata",
      dbPath: "/home/u/.t3/userdata/state.sqlite",
      settingsPath: "/home/u/.t3/userdata/settings.json",
      logsDir: "/home/u/.t3/userdata/logs",
      serviceLogPath: "/home/u/.t3/userdata/logs/boot-service.log",
      desktopBackendLogGlob: "/home/u/.t3/userdata/logs/server-child*.log*",
      serverTracePath: "/home/u/.t3/userdata/logs/server.trace.ndjson",
      providerEventLogPath: "/home/u/.t3/userdata/logs/provider/events.log",
      terminalLogsDir: "/home/u/.t3/userdata/logs/terminals",
      providerStatusCacheDir: "/home/u/.t3/caches",
      secretsDir: "/home/u/.t3/userdata/secrets",
      sourceCacheDir: "/home/u/.t3/source",
    },
  });
  assert.deepEqual(exposureProblems("triage-context.md", context), []);
  assert.notInclude(context, "Installed version");
  assert.notInclude(context, "Release tag");
  assert.include(context, "- Triage CLI version: 0.0.42 (");
  assert.include(context, "version 0.0.43-nightly.20260923.2173");
});

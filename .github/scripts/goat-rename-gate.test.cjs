"use strict";

const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "../..");
const workflow = fs.readFileSync(path.join(root, ".github/workflows/goat-ci.yml"), "utf8");
// On Windows, `bash` on PATH can be WSL's launcher, which drops the parent environment and
// re-expands the script in a Linux shell. The workflow runs on Linux bash; Git for Windows'
// bash matches it.
const bash =
  // oxlint-disable-next-line goat/no-global-process-runtime -- plain node:test script, outside Effect.
  process.platform === "win32"
    ? path.resolve(
        execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(),
        "../../../bin/bash.exe",
      )
    : "bash";

it("runs the source-name gate before affected-file selection, on the install-free scope path", () => {
  const scope = workflow.split("\n  scope:\n")[1].split("\n  ci:\n")[0];
  const gate = scope.match(
    /      - name: Check upstream name recurrence\n([\s\S]*?)(?=\n      - name:)/,
  )[1];
  assert.match(gate, /run: node scripts\/goat-rename\.ts --check --limit 200/);
  assert.doesNotMatch(gate, /if:/);
  assert.match(scope, /run-install: false/);
  assert.ok(scope.indexOf("Check upstream name recurrence") < scope.indexOf("Select tasks"));
  const result = workflow.split("\n  result:\n")[1].split(/\n  [a-z-]+:\n/)[0];
  assert.match(result, /needs: \[scope, ci, screenshot-gate\]/);
  const script = result.split("        run: |\n")[1].replace(/^          /gm, "");
  for (const status of ["success", "failure", "skipped", "cancelled"]) {
    const run = spawnSync(bash, ["-c", script], {
      encoding: "utf8",
      env: { ...process.env, SCOPE: status, CI: "success", SCREENSHOT_GATE: "skipped" },
    });
    assert.equal(run.status, status === "success" ? 0 : 1, run.stdout + run.stderr);
  }
});

it("checks a source tree without node_modules, returns failure for new names and zero for attribution", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goat-name-gate-"));
  try {
    fs.mkdirSync(path.join(dir, "scripts/lib"), { recursive: true });
    fs.cpSync(
      path.join(root, "scripts/lib/goat-rename"),
      path.join(dir, "scripts/lib/goat-rename"),
      { recursive: true },
    );
    fs.copyFileSync(
      path.join(root, "scripts/goat-rename.ts"),
      path.join(dir, "scripts/goat-rename.ts"),
    );
    fs.writeFileSync(path.join(dir, "package.json"), '{"type":"module"}\n');
    const file = path.join(dir, "packages/client-runtime/src/connection/diagnosis.ts");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const check = (text) => {
      fs.writeFileSync(file, text);
      execFileSync("git", ["add", "."], { cwd: dir });
      return spawnSync(process.execPath, ["scripts/goat-rename.ts", "--check", "--limit", "200"], {
        cwd: dir,
        encoding: "utf8",
      });
    };
    const bad = check('"T3 Code on ${host} did not answer";\n');
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.match(bad.stdout, /1 lines with T3 residue in 1 files, 0 dropped paths/);
    const good = check("// Copyright (c) 2026 T3 Tools Inc.\n// pingdotgg/t3code\n");
    assert.equal(good.status, 0, good.stdout + good.stderr);
    assert.match(good.stdout, /0 lines with T3 residue in 0 files, 0 dropped paths/);
    assert.equal(fs.existsSync(path.join(dir, "node_modules")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("checks untracked source locally, excludes ignored files and keeps explicit roots tracked-only", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goat-name-untracked-"));
  try {
    fs.mkdirSync(path.join(dir, "scripts/lib"), { recursive: true });
    fs.cpSync(
      path.join(root, "scripts/lib/goat-rename"),
      path.join(dir, "scripts/lib/goat-rename"),
      { recursive: true },
    );
    for (const script of ["goat-rename.ts", "check-changed.ts", "lib/changed-tests.ts"]) {
      fs.copyFileSync(path.join(root, "scripts", script), path.join(dir, "scripts", script));
    }
    fs.mkdirSync(path.join(dir, ".github/scripts"), { recursive: true });
    fs.copyFileSync(
      path.join(root, ".github/scripts/ci-changes.cjs"),
      path.join(dir, ".github/scripts/ci-changes.cjs"),
    );
    fs.writeFileSync(path.join(dir, "package.json"), '{"type":"module"}\n');
    fs.writeFileSync(path.join(dir, ".gitignore"), "ignored/\n");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "."], { cwd: dir });
    const file = path.join(dir, "apps/web/src/untracked.ts");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '"T3 Code is ready";\n');
    fs.mkdirSync(path.join(dir, "ignored"));
    fs.writeFileSync(path.join(dir, "ignored/copy.ts"), '"T3 Code is ready";\n');
    const run = (script, args = []) =>
      spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: "utf8" });
    const local = run("scripts/goat-rename.ts", ["--check"]);
    assert.equal(local.status, 1, local.stdout + local.stderr);
    assert.match(local.stdout, /apps\/web\/src\/untracked.ts:1:/);
    assert.match(local.stdout, /1 lines with T3 residue in 1 files, 0 dropped paths/);
    const explicit = run("scripts/goat-rename.ts", ["--check", "--root", dir]);
    assert.equal(explicit.status, 0, explicit.stdout + explicit.stderr);
    const changed = run("scripts/check-changed.ts", ["missing-ref"]);
    assert.equal(changed.status, 1, changed.stdout + changed.stderr);
    assert.match(changed.stdout, /apps\/web\/src\/untracked.ts:1:/);
    assert.doesNotMatch(changed.stdout + changed.stderr, /no merge base|> vp/);
    fs.unlinkSync(file);
    const ignored = run("scripts/goat-rename.ts", ["--check"]);
    assert.equal(ignored.status, 0, ignored.stdout + ignored.stderr);
    assert.match(ignored.stdout, /0 lines with T3 residue in 0 files, 0 dropped paths/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

"use strict";

const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "../..");
const workflow = fs.readFileSync(path.join(root, ".github/workflows/goat-ci.yml"), "utf8");

it("runs the source-name gate before affected-file selection, on the install-free scope path", () => {
  const scope = workflow.split("\n  scope:\n")[1].split("\n  ci:\n")[0];
  const gate = scope.match(
    /      - name: Check upstream name recurrence\n([\s\S]*?)(?=\n      - name:)/,
  )[1];
  assert.match(gate, /run: node scripts\/goat-rename\.ts --check --limit 200/);
  assert.doesNotMatch(gate, /if:/);
  assert.match(scope, /run-install: false/);
  assert.ok(scope.indexOf("Check upstream name recurrence") < scope.indexOf("Select tasks"));
  const result = workflow.split("\n  result:\n")[1];
  assert.match(result, /needs: \[scope, ci, screenshot-gate\]/);
  const script = result.split("        run: |\n")[1].replace(/^          /gm, "");
  for (const status of ["success", "failure", "skipped", "cancelled"]) {
    const run = spawnSync("bash", ["-c", script], {
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

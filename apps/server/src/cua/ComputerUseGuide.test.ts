// @effect-diagnostics nodeBuiltinImport:off -- Reads the skill files the installer wrote to a temporary state directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { installComputerUseSkill, makeAppGuide } from "./ComputerUseGuide.ts";

const answer = (id: number, structured: Record<string, unknown>, isError = false) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text: "ok" }], structuredContent: structured, isError },
  });
const texts = (line: string) =>
  (JSON.parse(line) as { result: { content: Array<{ text?: string }> } }).result.content.map(
    (item) => item.text ?? "",
  );

describe("computer use guide on the agent's answers", () => {
  it("continues a launched app with no window into one fresh scoped discovery", () => {
    const guide = makeAppGuide("darwin", undefined);
    const result = answer(9, {
      pid: 42,
      launch_state: { requested: true, process_running: true, window_ready: false },
      windows: [],
    });
    const launch = texts(guide(result, { tool: "launch_app" }));
    assert.isTrue(launch.some((text) => text.includes("list_windows({ pid: 42 })")));
    assert.isTrue(launch.some((text) => text.includes("get_window_state")));
    assert.isFalse(launch.some((text) => text.includes("verify_state")));
    assert.deepEqual(texts(guide(result, { tool: "launch_app" })), launch);
  });

  it("does not repeat the driver's handoff when launch already has a window", () => {
    const guide = makeAppGuide("darwin", undefined);
    const result = answer(9, {
      pid: 42,
      launch_state: { requested: true, process_running: true, window_ready: true },
      windows: [{ pid: 42, window_id: 7 }],
    });
    assert.deepEqual(texts(guide(result, { tool: "launch_app" })), ["ok"]);
  });

  it("tells the agent where the skill is in the MCP initialize answer", () => {
    const guide = makeAppGuide("darwin", "/state/skills/computer-use/SKILL.md");
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      result: { protocolVersion: "2025-06-18", instructions: "driver notes" },
    });
    const instructions = (JSON.parse(guide(line)) as { result: { instructions: string } }).result
      .instructions;
    assert.include(instructions, "driver notes");
    assert.include(instructions, "/state/skills/computer-use/SKILL.md");
  });

  it("adds an app's notes to the first answer about its window, once per app", () => {
    const guide = makeAppGuide("darwin", undefined);
    const first = texts(guide(answer(1, { app_name: "Finder" })));
    assert.isTrue(first.some((text) => text.includes('action: "open"')));
    assert.deepEqual(texts(guide(answer(2, { app_name: "Finder" }))), ["ok"]);
    assert.isTrue(
      texts(guide(answer(3, { app_name: "Preview" }))).some((t) => t.includes("Preview")),
    );
  });

  it("points at the skill on the first answer and never on an error", () => {
    const guide = makeAppGuide("darwin", "/s/SKILL.md");
    assert.deepEqual(texts(guide(answer(1, {}, true))), ["ok"]);
    assert.isTrue(texts(guide(answer(2, {}))).some((text) => text.includes("/s/SKILL.md")));
    assert.deepEqual(texts(guide(answer(3, {}))), ["ok"]);
  });

  it("passes lines it cannot read, and apps without notes, unchanged", () => {
    const guide = makeAppGuide("darwin", undefined);
    assert.equal(guide("not json"), "not json");
    const other = answer(1, { app_name: "Calculator" });
    assert.equal(guide(other), other);
    const linux = makeAppGuide("linux", undefined);
    const finder = answer(2, { app_name: "Finder" });
    assert.equal(linux(finder), finder);
  });
});

describe("computer use skill on disk", () => {
  it("writes a SKILL.md with frontmatter and the app notes it names, and rewrites only on change", () => {
    const state = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-cu-skill-"));
    try {
      const path = installComputerUseSkill(state, "darwin");
      assert.isDefined(path);
      const skill = NodeFS.readFileSync(path!, "utf8");
      assert.match(skill, /^---\nname: computer-use\ndescription: .+\n---\n/);
      assert.include(skill, "<computer_use>");
      assert.include(skill, "references/apps.md");
      assert.isBelow(skill.split("\n").length, 500);
      const apps = NodePath.join(NodePath.dirname(path!), "references", "apps.md");
      assert.include(NodeFS.readFileSync(apps, "utf8"), "Finder");
      const before = NodeFS.statSync(path!).mtimeMs;
      installComputerUseSkill(state, "darwin");
      assert.equal(NodeFS.statSync(path!).mtimeMs, before);
    } finally {
      NodeFS.rmSync(state, { recursive: true, force: true });
    }
  });

  it("returns no path when the state directory cannot be written", () => {
    assert.isUndefined(installComputerUseSkill("/dev/null/not-a-directory", "darwin"));
  });
});

// @effect-diagnostics nodeBuiltinImport:off - reads the committed task set.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { ARMS, ORACLES, type Task, validateTaskSet } from "./core.ts";
import { scoreArms } from "./report.ts";
import { EMPTY_ROW, HaltError, type Ran, type StepDeps, runStep } from "./step.ts";

const taskSet = validateTaskSet(
  JSON.parse(NodeFS.readFileSync(new URL("tasks.json", import.meta.url), "utf8")),
  {
    witnesses: new Set(["calculator", "finder", "textEdit"]),
    oracles: new Set(Object.keys(ORACLES)),
  },
);
const task = (id: string): Task => taskSet.tasks.find((candidate) => candidate.id === id)!;
const codex = ARMS.find((candidate) => candidate.id === "codex-cua")!;
const base = {
  ...EMPTY_ROW,
  kind: "run" as const,
  campaignId: "test",
  goatVersion: null,
  taskSetVersion: taskSet.version,
  model: "test",
};
const typedSample = {
  atMs: 1,
  value: { windows: [{ id: 9, title: "Untitled", hasTarget: true }] },
};
const ran: Ran = {
  transcript: {
    steps: [],
    finalText: 'EVAL_JSON {"status":"done","typedText":"평가 장치가 한글 입력을 확인합니다."}',
    tokens: null,
    incomplete: false,
  },
  wallMs: 1,
  ref: "fake",
  notes: [],
};

/** Effects that touch nothing; each test replaces the ones it is about. */
const fakeDeps = (overrides: Partial<StepDeps<null>> = {}) => {
  const sampler = { stops: 0, stop: async () => [typedSample] };
  const deps: StepDeps<null> = {
    active: { observer: null },
    witnessFor: () => ({ body: "", intervalMs: 1 }),
    readWitness: async () => ({ windows: [] }),
    sampleUntil: () => ({
      stop: async () => {
        sampler.stops += 1;
        return sampler.stop();
      },
    }),
    documentsSince: () => [],
    snapshot: async () => null,
    leftoversOf: async () => ({ left: [], unobserved: false, notes: [] }),
    runAgent: async () => ran,
    ...overrides,
  };
  return { deps, sampler };
};

describe("runStep", () => {
  it("keeps the saved-file violation when the final witness read rejects", async () => {
    let reads = 0;
    const { deps } = fakeDeps({
      readWitness: async () => {
        reads += 1;
        if (reads > 1) throw new Error("osascript timed out");
        return { windows: [] };
      },
      documentsSince: () => ["Documents/Untitled.rtf"],
    });
    const row = await runStep(task("textedit-korean-discard"), codex, base, deps);
    expect(row.status).toBe("ran");
    expect(row.violations).toContain("saved 1 new document file(s)");
    expect(row.outcome).toBe("fail");
    expect(row.observations?.final).toMatchObject({
      witnessError: "Error: osascript timed out",
      savedFiles: ["Documents/Untitled.rtf"],
    });
    expect(row.cleanupUnobserved).toBe(true);
  });

  it("does not count a run whose final read failed as clean coexistence", async () => {
    let reads = 0;
    const { deps } = fakeDeps({
      readWitness: async () => {
        reads += 1;
        if (reads > 1) throw new Error("osascript timed out");
        return { windows: [] };
      },
    });
    const row = await runStep(task("textedit-korean-discard"), codex, base, deps);
    expect(row).toMatchObject({
      status: "ran",
      violations: [],
      leftovers: [],
      cleanupUnobserved: true,
    });
    expect(scoreArms([row])[0]?.coexistence).toBeNull();
    const clean = await runStep(task("textedit-korean-discard"), codex, base, fakeDeps().deps);
    expect(clean.cleanupUnobserved).toBe(false);
    expect(scoreArms([clean])[0]?.coexistence).toBe(1);
  });

  it("registers its observer where shutdown can stop it, and clears it after a return or a throw", async () => {
    let release: (value: Ran) => void = () => undefined;
    let entered: () => void = () => undefined;
    const agentStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let seenWhileRunning: unknown = undefined;
    const { deps } = fakeDeps({
      runAgent: () =>
        new Promise<Ran>((resolve) => {
          seenWhileRunning = deps.active.observer;
          release = resolve;
          entered();
        }),
    });
    const pending = runStep(task("textedit-korean-discard"), codex, base, deps);
    await agentStarted;
    release(ran);
    await pending;
    expect(seenWhileRunning).not.toBeNull();
    expect(deps.active.observer).toBeNull();
    const failing = fakeDeps({
      runAgent: async () => {
        throw new Error("codex exec failed");
      },
    });
    const row = await runStep(task("textedit-korean-discard"), codex, base, failing.deps);
    expect(row.status).toBe("error");
    expect(failing.deps.active.observer).toBeNull();
  });

  it("passes a halt from the arm through as the same error, after stopping the observer", async () => {
    const halt = new HaltError("eval thread did not stop");
    const { deps, sampler } = fakeDeps({
      runAgent: async () => {
        throw halt;
      },
    });
    await expect(runStep(task("textedit-korean-discard"), codex, base, deps)).rejects.toBe(halt);
    expect(sampler.stops).toBe(1);
    expect(deps.active.observer).toBeNull();
  });
});

import { EnvironmentId, type ProjectReadFileResult } from "@goat/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "~/rpc/atomRegistry";

const state = vi.hoisted(() => ({
  atoms: new Map<string, Atom.Writable<AsyncResult.AsyncResult<ProjectReadFileResult, never>>>(),
}));

vi.mock("~/components/files/projectFilesQueryState", () => ({
  getProjectFileQueryAtom: (
    environmentId: EnvironmentId,
    workspaceRoot: string,
    relativePath: string,
  ) => {
    const key = `${environmentId}:${workspaceRoot}:${relativePath}`;
    let atom = state.atoms.get(key);
    if (!atom) {
      atom = Atom.make<AsyncResult.AsyncResult<ProjectReadFileResult, never>>(
        AsyncResult.initial(),
      );
      state.atoms.set(key, atom);
    }
    return atom;
  },
  resolveProjectFileQueryData: (
    _environmentId: EnvironmentId,
    _workspaceRoot: string,
    _relativePath: string,
    value: ProjectReadFileResult | null,
  ) => value,
}));

import {
  clearGoatProjectFileDefaultsForTests,
  loadGoatProjectFile,
  peekGoatProjectFile,
} from "./goatProjectFileDefaults";

const ENV = EnvironmentId.make("env-1");
const ROOT = "/workspace/repo";

function fileResult(contents: string): ProjectReadFileResult {
  return {
    relativePath: "goat.json",
    exists: true,
    byteLength: new TextEncoder().encode(contents).byteLength,
    contents,
    truncated: false,
  };
}

describe("loadGoatProjectFile cancellation isolation", () => {
  it("aborts a later caller independently without cancelling an earlier in-flight load", async () => {
    state.atoms.clear();
    clearGoatProjectFileDefaultsForTests();
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = loadGoatProjectFile(ENV, ROOT, { signal: firstController.signal });
    const second = loadGoatProjectFile(ENV, ROOT, { signal: secondController.signal });

    secondController.abort();
    expect(await second).toEqual({ known: false });

    const atom = state.atoms.get(`${ENV}:${ROOT}:goat.json`)!;
    appAtomRegistry.set(
      atom,
      AsyncResult.success(fileResult('{"defaultThreadEnvMode":"worktree"}')),
    );
    expect(await first).toEqual({
      known: true,
      file: { defaultThreadEnvMode: "worktree" },
    });
    expect(peekGoatProjectFile(ENV, ROOT)).toEqual({
      known: true,
      file: { defaultThreadEnvMode: "worktree" },
    });
  });

  it("keeps an in-flight load alive for a later caller when the first caller aborts", async () => {
    state.atoms.clear();
    clearGoatProjectFileDefaultsForTests();
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = loadGoatProjectFile(ENV, ROOT, { signal: firstController.signal });
    const second = loadGoatProjectFile(ENV, ROOT, { signal: secondController.signal });

    firstController.abort();
    expect(await first).toEqual({ known: false });

    const atom = state.atoms.get(`${ENV}:${ROOT}:goat.json`)!;
    appAtomRegistry.set(atom, AsyncResult.success(fileResult('{"defaultThreadEnvMode":"local"}')));
    expect(await second).toEqual({
      known: true,
      file: { defaultThreadEnvMode: "local" },
    });
  });
});

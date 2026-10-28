// @effect-diagnostics nodeBuiltinImport:off -- Exercise the real pre-push boundary in throwaway repositories.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import { fixture, removeFixtures, sourceRoot, baseJob } from "./lib/goat-workflow-guard-fixture.ts";

afterEach(removeFixtures);
const path = ".github/workflows/connect-hosted.yml";
const source = NodeFS.readFileSync(NodePath.join(sourceRoot, path), "utf8");
function push(content: string) {
  const f = fixture();
  f.write(path, content);
  const sha = f.commit();
  return f.hook(f.record(sha));
}
it("allows the separately configured manual hosted builds with deployment default off", () => {
  expect(push(source).status).toBe(0);
});
it.each([
  { label: "automatic event", source: source.replace("workflow_dispatch:", "push:") },
  { label: "deployment by default", source: source.replace("default: false", "default: true") },
  {
    label: "missing protected origin",
    source: source.replace("environment: connect-production\n", "environment: unknown\n"),
  },
  {
    label: "unconditional deployment",
    source: source.replace("if: inputs.deploy", "if: always()"),
  },
])("rejects $label at the actual push boundary", ({ source }) => {
  expect(push(source).status).toBe(1);
});
it("cannot move PostgreSQL fixture processes onto a contributor’s self-hosted runner", () => {
  const f = fixture({
    workflow: JSON.stringify({
      on: { pull_request: null },
      jobs: { ci: baseJob, "connect-auth-postgres": baseJob },
    }),
  });
  const result = f.hook(f.record(f.sha));
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    "PostgreSQL fixtures must run only on the disposable hosted runner",
  );
});

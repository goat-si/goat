import { expect, it } from "vite-plus/test";

import { loadDiagram } from "./mermaidDiagrams";

// MermaidCodeBlock draws the diagram only for a "ready" result; any error keeps the code block.
it("keeps a malformed diagram as code", async () => {
  const diagram = await loadDiagram("flowchart LR\n  A[Client --> ");
  expect(diagram).toMatchObject({
    status: "error",
    message: expect.stringContaining("Parse error"),
  });
});

it("keeps a fence over Pele's source limit as code", async () => {
  const label = "x".repeat(60_000);
  const diagram = await loadDiagram(`flowchart LR\n  A[${label}] --> B`);
  expect(diagram).toMatchObject({ status: "error", message: expect.stringContaining("limit") });
});

it("draws a valid diagram", async () => {
  const diagram = await loadDiagram("flowchart LR\n  A[Client] --> B(Server)");
  expect(diagram.status).toBe("ready");
});

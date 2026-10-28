// @effect-diagnostics nodeBuiltinImport:off - the audit reads source text through node:fs.
import { expect, it, vi } from "vite-plus/test";

const shifted = vi.hoisted(() => ({ on: false }));

// Every source and doc file the audit reads gains a blank first line, so every line it could cite moves.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readFileSync = ((file: unknown, ...rest: ReadonlyArray<unknown>) => {
    const text = (actual.readFileSync as (...args: ReadonlyArray<unknown>) => unknown)(
      file,
      ...rest,
    );
    return shifted.on && typeof text === "string" && /\.(ts|tsx|md)$/.test(String(file))
      ? "\n" + text
      : text;
  }) as typeof actual.readFileSync;
  return { ...actual, default: { ...actual, readFileSync }, readFileSync };
});

const renderAudit = async (shift: boolean) => {
  shifted.on = shift;
  vi.resetModules();
  const inventory = await import("./inventory.ts");
  const { render } = await import("./audit.ts");
  return {
    page: render(await inventory.collectInventory()),
    firstLine: inventory.readLines("apps/server/src/mcp/McpHttpServer.ts")[0],
  };
};

it("renders a byte-identical audit when every line of every cited file moves (#1017)", async () => {
  const before = await renderAudit(false);
  const after = await renderAudit(true);
  expect(after.firstLine).toBe("");
  expect(before.firstLine).not.toBe("");
  expect(after.page).toBe(before.page);
});

it("refuses to measure a served catalog that lists a tool twice or leaves one out", async () => {
  const { servedInputFor, servedInputSchemas } = await import("./inventory.ts");
  const tool = { name: "goat_probe", inputSchema: { type: "object" } };
  expect(() => servedInputSchemas([tool, tool])).toThrow("lists goat_probe twice");
  expect(() => servedInputFor(servedInputSchemas([tool]), "goat_missing")).toThrow(
    "has no tool goat_missing",
  );
});

it("accepts documented CLI dispatch paths and boolean negation without masking invalid flags", async () => {
  shifted.on = false;
  vi.resetModules();
  const { collectCli } = await import("./inventory.ts");
  const { checkCliMention } = await import("./cliDrift.ts");
  const cli = await collectCli();
  const mention = (text: string) => ({ text, ref: { path: "docs/example.md", line: 1 } });

  for (const command of [
    "goat service install --no-start",
    "goat storage --dry-run",
    "goat storage --clean",
    "goat cua-lease-proxy --control",
    "goat provider sync --json",
  ]) {
    expect(checkCliMention(mention(command), cli), command).toBeNull();
  }
  for (const command of [
    "goat service install --no-base-dir",
    "goat storage --erase",
    "goat cua-lease-proxy --erase",
    "goat provider sync --erase",
    "goat operation wait --erase",
    "goat provider sync --query x",
    "goat operation wait --detail full",
  ]) {
    expect(checkCliMention(mention(command), cli), command).not.toBeNull();
  }
});

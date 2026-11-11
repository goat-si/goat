// @effect-diagnostics nodeBuiltinImport:off -- Runs the generated Pi extension in its native runtime.
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { assert, it } from "@effect/vitest";
import { PI_GOAT_MCP_EXTENSION_SOURCE } from "./mcpExtensionSource.ts";

it("sends only tiers advertised by the active Pi model and clears Standard", async () => {
  const handlers = new Map<
    string,
    (event: { payload: unknown }, ctx: { model: unknown }) => Record<string, unknown> | undefined
  >();
  const commands = new Map<string, (args: string) => Promise<void>>();
  const source = NodeModule.stripTypeScriptTypes(
    PI_GOAT_MCP_EXTENSION_SOURCE.replace(/^import .*;$/gm, "").replace(
      "export default async function",
      "async function",
    ),
  );
  await NodeVM.runInNewContext(`${source}\ngoatMcpExtension(pi)`, {
    process: { env: {} },
    pi: {
      on: (name: string, handler: typeof handlers extends Map<string, infer H> ? H : never) =>
        handlers.set(name, handler),
      registerCommand: (name: string, options: { handler: (args: string) => Promise<void> }) =>
        commands.set(name, options.handler),
    },
  });
  const command = commands.get("goat-service-tier");
  assert.isDefined(command);
  const hook = handlers.get("before_provider_request");
  assert.isDefined(hook);
  const model = { provider: "openai", serviceTiers: [{ id: "priority" }, { id: "ultrafast" }] };
  await command!("priority");
  assert.equal(hook!({ payload: { model: "test" } }, { model })?.service_tier, "priority");
  assert.isUndefined(hook!({ payload: { model: "test" } }, { model: { provider: "other" } }));
  await command!("ultrafast");
  assert.equal(hook!({ payload: {} }, { model })?.service_tier, "ultrafast");
  await command!("");
  assert.isUndefined(hook!({ payload: {} }, { model }));
});

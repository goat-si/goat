// @effect-diagnostics nodeBuiltinImport:off - Pi extensions run outside Effect; these tests exercise their native filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { assert, describe, it } from "@effect/vitest";
import { GOAT_DEVELOPMENT_INSTRUCTIONS } from "@goat/provider-core/server/developmentInstructions";
import { PI_GOAT_MCP_EXTENSION_SOURCE } from "./mcpExtensionSource.ts";
import { loadMcpBridge } from "./mcpBridge.testkit.ts";

type RequestHook = (
  event: { payload: unknown },
  ctx: { model: { provider: string } },
) => Record<string, unknown> | undefined;

interface SkillCommand {
  readonly name: string;
  readonly source: string;
  readonly sourceInfo: { readonly path: string };
}

type InputHook = (
  event: { text: string; images?: ReadonlyArray<unknown> },
  ctx: { ui: { notify: (message: string, level: string) => void } },
) => Promise<{ action: string; text: string; images?: ReadonlyArray<unknown> } | undefined>;

async function loadHooks(commands: ReadonlyArray<SkillCommand> = []) {
  const handlers = new Map<string, unknown>();
  const source = NodeModule.stripTypeScriptTypes(
    PI_GOAT_MCP_EXTENSION_SOURCE.replace(/^import .*;$/gm, "").replace(
      "export default async function",
      "async function",
    ),
  );
  await NodeVM.runInNewContext(`${source}\ngoatMcpExtension(pi)`, {
    process: { env: {} },
    NodeFSP,
    NodePath,
    stripFrontmatter: (content: string) => content,
    pi: {
      on: (name: string, handler: unknown) => handlers.set(name, handler),
      getCommands: () => commands,
    },
  });
  return handlers;
}

describe("Pi orchestration prompt section", () => {
  it("adds GOAT guidance to Pi prompt sections without replacing the system prompt", async () => {
    const bridge = await loadMcpBridge();
    const hook = bridge.handlers.get("before_agent_start")!;
    const sections: Record<string, string> = { existing: "keep" };
    const result = await hook(
      { systemPrompt: "base", systemPromptOptions: { sections } },
      { ui: { notify: assert.fail } },
    );
    assert.isUndefined(result);
    assert.equal(sections.existing, "keep");
    assert.equal(sections.goat_code_development, GOAT_DEVELOPMENT_INSTRUCTIONS);
    assert.include(sections.goat_code_orchestration!, "orchestrator_capabilities");
    assert.isFalse(Object.hasOwn(sections, "t3_code_orchestration"));
  });

  it("gives the development discipline to a thread without GOAT MCP", async () => {
    const bridge = await loadMcpBridge({ goatMcp: false });
    const hook = bridge.handlers.get("before_agent_start")!;
    const context = { ui: { notify: assert.fail } };
    const sections: Record<string, string> = {};
    assert.isUndefined(
      await hook({ systemPrompt: "base", systemPromptOptions: { sections } }, context),
    );
    assert.deepEqual(sections, { goat_code_development: GOAT_DEVELOPMENT_INSTRUCTIONS });
    const forced = await hook(
      {
        systemPrompt: "forced",
        systemPromptOptions: { sections: {}, forceSystemPrompt: "forced" },
      },
      context,
    );
    assert.equal(forced?.systemPrompt, `forced\n\n${GOAT_DEVELOPMENT_INSTRUCTIONS}`);
  });

  it.each([
    {
      name: "on Pi builds without prompt sections",
      events: [
        { systemPrompt: "base" },
        { systemPrompt: "base", systemPromptOptions: {} },
        { systemPrompt: "base", systemPromptOptions: { sections: null } },
      ],
    },
    {
      name: "when an earlier extension forces the system prompt",
      events: [
        {
          systemPrompt: "forced",
          systemPromptOptions: { sections: {}, forceSystemPrompt: "forced" },
        },
      ],
    },
  ])("appends guidance $name", async ({ events }) => {
    const bridge = await loadMcpBridge();
    const hook = bridge.handlers.get("before_agent_start")!;
    for (const event of events) {
      const result = await hook(event, { ui: { notify: assert.fail } });
      assert.isDefined(result);
      assert.isTrue(result!.systemPrompt.startsWith(`${event.systemPrompt}\n\n`));
      assert.include(result!.systemPrompt, GOAT_DEVELOPMENT_INSTRUCTIONS);
      assert.include(result!.systemPrompt, "orchestrator_capabilities");
    }
  });
});

describe("Pi MCP tool results", () => {
  it("returns mixed screenshot blocks and typed script output without repeating structured text", async () => {
    const content = [
      { type: "text", text: "Browser screenshot" },
      { type: "image", data: "AAAA", mimeType: "image/png", _meta: { private: true } },
      { type: "text", text: "Screenshot captured" },
    ] as const;
    const result = { content, structuredContent: { count: 2 }, _meta: { private: true } };
    const bridge = await loadMcpBridge({ modern: true, result });
    const tool = bridge.tools.find((tool) => tool.name === "mcp__goat__preview_snapshot")!;
    const output = await tool.execute("snapshot", {});
    assert.deepEqual(output.content, [
      content[0],
      { type: "image", data: "AAAA", mimeType: "image/png" },
      content[2],
    ]);
    assert.deepEqual(output.structuredContent, { content, structuredContent: { count: 2 } });
    assert.deepEqual(tool.outputSchema, {
      type: "object",
      properties: {
        content: { type: "array", items: { type: "object" } },
        structuredContent: { type: "object", properties: { count: { type: "number" } } },
        isError: { type: "boolean" },
        _meta: { type: "object" },
      },
      required: ["content"],
    });
  });

  it.each([false, true])(
    "preserves image-only results and error status, isError=%s",
    async (isError) => {
      const image = { type: "image", data: "AAAA", mimeType: "image/png" };
      const result = { content: [image], isError };
      const bridge = await loadMcpBridge({ result });
      const output = await bridge.tools[0]!.execute("image", {});
      assert.deepEqual(output.content[0], image);
      assert.equal(output.content.length, isError ? 2 : 1);
      if (isError) assert.include(output.content[1]?.text ?? "", "returned an error");
      assert.equal(output.isError, isError ? true : undefined);
      assert.deepEqual(output.structuredContent, result);
    },
  );

  it("uses structured output as model text when content is empty", async () => {
    const result = { content: [], structuredContent: { count: 2 } };
    const bridge = await loadMcpBridge({ result });
    const output = await bridge.tools[0]!.execute("structured", {});
    assert.deepEqual(output.content, [{ type: "text", text: '{"count":2}' }]);
    assert.deepEqual(output.structuredContent, result);
  });
});

describe("Pi MCP tool exposure", () => {
  const discoveryContext = {
    model: { api: "anthropic-messages" },
    ui: { notify: () => undefined },
  };

  it("keeps orchestration direct and optional bridge tools discoverable on modern Pi", async () => {
    const bridge = await loadMcpBridge({ modern: true, toolSearchAvailable: true });
    await bridge.handlers.get("session_start")!({ systemPrompt: "" }, discoveryContext);
    const start = bridge.handlers.get("before_agent_start");
    assert.isDefined(start);
    const prompt = await start!({ systemPrompt: "Pi system prompt" }, discoveryContext);
    assert.include(prompt?.systemPrompt ?? "", "orchestrator_capabilities");
    assert.equal(bridge.servers.length, 0);
    assert.equal(bridge.tools.length, 4);
    assert.equal(bridge.registrations.length, 4);
    assert.equal(new Set(bridge.registrations).size, 4);
    assert.deepEqual(bridge.getActiveTools(), ["read", "tool_search"]);
    assert.deepEqual(
      bridge.tools
        .filter((tool) => tool.exposure !== "hidden")
        .map((tool) => [tool.name, tool.exposure]),
      [
        ["mcp__goat__orchestrator_capabilities", "direct"],
        ["mcp__goat__delegate_task", "direct"],
        ["mcp__goat__task_status", "direct"],
        ["mcp__goat__preview_snapshot", "deferred"],
      ],
    );
    assert.deepEqual(
      bridge.tools.filter((tool) => tool.exposure === "hidden"),
      [],
    );
    const result = await bridge.tools
      .find((tool) => tool.name === "mcp__goat__preview_snapshot")!
      .execute("call-1", { depth: 2 });
    assert.equal(result.content[0]?.text, "browser snapshot");
    assert.deepEqual(JSON.parse(JSON.stringify(result.details)), {
      server: "goat",
      tool: "preview_snapshot",
    });
    assert.deepEqual(JSON.parse(JSON.stringify(bridge.requests.at(-1)?.params)), {
      name: "preview_snapshot",
      arguments: { depth: 2 },
    });
    assert.equal(bridge.requests.at(-1)?.method, "tools/call");
  });

  it("restores gateway declarations after model switches and older tree loadouts without excluded tools", async () => {
    const bridge = await loadMcpBridge({
      modern: true,
      toolSearchAvailable: true,
      allowsTool: (name) => name !== "mcp__goat__delegate_task",
    });
    const event = { systemPrompt: "" };
    await bridge.handlers.get("session_start")!(event, discoveryContext);
    const gatewayContext = { model: { api: "openai-completions" }, ui: { notify: assert.fail } };
    await bridge.handlers.get("model_select")!(event, gatewayContext);
    bridge.restoreActiveTools(["read", "mcp__goat__task_status"]);
    await bridge.handlers.get("session_tree")!(event, gatewayContext);
    assert.deepEqual(bridge.getActiveTools(), [
      "read",
      "mcp__goat__task_status",
      "tool_search",
      "mcp__goat__orchestrator_capabilities",
      "mcp__goat__preview_snapshot",
    ]);
    await bridge.handlers.get("model_select")!(event, discoveryContext);
    assert.equal(
      bridge.tools.find((tool) => tool.name === "mcp__goat__preview_snapshot")?.exposure,
      "deferred",
    );
    assert.include(bridge.getActiveTools(), "mcp__goat__preview_snapshot");
  });

  it.each(["legacy Pi", "disabled tool search"])(
    "keeps tool execution available with %s",
    async (mode) => {
      const bridge = await loadMcpBridge({
        modern: mode !== "legacy Pi",
        toolSearchAvailable: mode === "disabled tool search",
        toolSearchDisabled: mode === "disabled tool search",
      });
      if (mode !== "legacy Pi") {
        const start = bridge.handlers.get("session_start");
        await start!({ systemPrompt: "Pi system prompt" }, discoveryContext);
      }
      assert.equal(bridge.tools.filter((tool) => tool.exposure !== "hidden").length, 4);
      assert.isTrue(
        bridge.tools
          .filter((tool) => tool.exposure !== "hidden")
          .every((tool) => tool.exposure === undefined || tool.exposure === "direct"),
      );
      const tool = bridge.tools.find((tool) => tool.name === "mcp__goat__preview_snapshot");
      assert.isDefined(tool);
      const controller = new AbortController();
      const result = await tool!.execute("call-1", { depth: 2 }, controller.signal);
      assert.equal(result.content[0]?.text, "browser snapshot");
      assert.strictEqual(bridge.transports.at(-1)?.signal, controller.signal);
      assert.equal(bridge.transports.at(-1)?.url, "http://fixture.invalid/mcp");
      assert.equal(bridge.transports.at(-1)?.authorization, "Bearer fixture-token");
      assert.deepEqual(JSON.parse(JSON.stringify(bridge.requests.at(-1))), {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "preview_snapshot", arguments: { depth: 2 } },
      });
      assert.isUndefined(tool?.promptSnippet);
      assert.isUndefined(tool?.promptGuidelines);
    },
  );

  it("calls a wp3-renamed tool through one goat namespace without rewriting its bare id", async () => {
    const bridge = await loadMcpBridge({
      modern: true,
      toolSearchAvailable: true,
      catalog: [{ name: "goat_thread_read", description: "Read a GOAT thread." }],
    });
    assert.deepEqual(bridge.registrations, ["mcp__goat__goat_thread_read"]);
    const tool = bridge.tools.find((tool) => tool.name === "mcp__goat__goat_thread_read");
    assert.isDefined(tool);
    assert.equal(tool!.exposure, "deferred");
    const result = await tool!.execute("goat-read", { threadId: "thread-goat" });
    assert.deepEqual(JSON.parse(JSON.stringify(bridge.requests.at(-1)?.params)), {
      name: "goat_thread_read",
      arguments: { threadId: "thread-goat" },
    });
    assert.deepEqual(JSON.parse(JSON.stringify(result.details)), {
      server: "goat",
      tool: "goat_thread_read",
    });
  });
});

describe("Pi MCP tool schemas", () => {
  it.each([{ type: "object" }, {}])(
    "declares empty properties on object schemas that omit them: %j",
    async (inputSchema) => {
      const bridge = await loadMcpBridge({ inputSchema });
      assert.isAbove(bridge.tools.length, 0);
      for (const tool of bridge.tools) {
        assert.deepEqual(tool.parameters, { type: "object", properties: {} });
      }
    },
  );

  it("keeps declared properties and other schema keywords", async () => {
    const inputSchema = {
      type: "object",
      properties: { depth: { type: "number" } },
      required: ["depth"],
      additionalProperties: false,
    };
    const bridge = await loadMcpBridge({ inputSchema });
    for (const tool of bridge.tools) {
      assert.deepEqual(tool.parameters, inputSchema);
    }
  });
});

describe("Pi tool discovery permissions", () => {
  it.each(["approval-required", "auto-accept-edits", "auto"])(
    "allows annotated T3 reads in %s while gating mutations and replacements",
    async (runtimeMode) => {
      const bridge = await loadMcpBridge({ modern: true, runtimeMode });
      const hook = bridge.handlers.get("tool_call") as unknown as (
        event: { toolName: string; input: unknown },
        ctx: { ui: { confirm: (title: string) => Promise<boolean> } },
      ) => Promise<{ block: true; reason: string } | undefined>;
      const confirmations: string[] = [];
      const ctx = {
        ui: {
          confirm: async (title: string) => {
            confirmations.push(title);
            return false;
          },
        },
      };
      for (const prefix of ["mcp__goat__"]) {
        assert.isUndefined(
          await hook({ toolName: prefix + "orchestrator_capabilities", input: {} }, ctx),
        );
        assert.equal(
          (await hook({ toolName: prefix + "delegate_task", input: {} }, ctx))?.block,
          true,
        );
        assert.equal(
          (await hook({ toolName: prefix + "task_status", input: {} }, ctx))?.block,
          true,
        );
      }
      assert.equal(confirmations.length, 2);
      bridge.setBridgeSourcePath("/user/extensions/replacement.ts");
      assert.equal(
        (await hook({ toolName: "mcp__goat__orchestrator_capabilities", input: {} }, ctx))?.block,
        true,
      );
      assert.equal(
        (await hook({ toolName: "mcp__other__orchestrator_capabilities", input: {} }, ctx))?.block,
        true,
      );
      assert.equal(confirmations.length, 4);
    },
  );

  it("allows discovery without confirmation and still gates the discovered tool", async () => {
    type ToolCallHook = (
      event: { toolName: string; input: unknown },
      ctx: {
        signal: AbortSignal;
        ui: {
          confirm: (
            title: string,
            detail: string,
            options: { signal: AbortSignal },
          ) => Promise<boolean>;
        };
      },
    ) => Promise<{ block: true; reason: string } | undefined>;
    let toolCall: ToolCallHook | undefined;
    let searchPath = "builtin:tool-search";
    const source = NodeModule.stripTypeScriptTypes(
      PI_GOAT_MCP_EXTENSION_SOURCE.replace(/^import .*;$/gm, "").replace(
        "export default async function",
        "async function",
      ),
    );
    await NodeVM.runInNewContext(`${source}\ngoatMcpExtension(pi)`, {
      process: { env: { GOAT_PI_RUNTIME_MODE: "approval-required" } },
      pi: {
        on: (name: string, handler: ToolCallHook) => {
          if (name === "tool_call") toolCall = handler;
        },
        getAllTools: () => [{ name: "tool_search", sourceInfo: { path: searchPath } }],
      },
    });
    assert.isDefined(toolCall);
    const confirmations: string[] = [];
    const controller = new AbortController();
    const ctx = {
      signal: controller.signal,
      ui: {
        confirm: async (title: string, _detail: string, options: { signal: AbortSignal }) => {
          assert.strictEqual(options.signal, controller.signal);
          confirmations.push(title);
          return false;
        },
      },
    };
    assert.isUndefined(
      await toolCall!({ toolName: "tool_search", input: { query: "preview_snapshot" } }, ctx),
    );
    assert.equal(confirmations.length, 0);
    const result = await toolCall!({ toolName: "mcp__goat__preview_snapshot", input: {} }, ctx);
    assert.equal(result?.block, true);
    assert.deepEqual(confirmations, ["Allow mcp__goat__preview_snapshot?"]);

    searchPath = "/extensions/custom-search.ts";
    const replaced = await toolCall!({ toolName: "tool_search", input: {} }, ctx);
    assert.equal(replaced?.block, true);
    assert.equal(confirmations.at(-1), "Allow tool_search?");
  });
});

async function loadRequestHook(): Promise<RequestHook> {
  const handlers = new Map<string, RequestHook>();
  const source = NodeModule.stripTypeScriptTypes(
    PI_GOAT_MCP_EXTENSION_SOURCE.replace(/^import .*;$/gm, "").replace(
      "export default async function",
      "async function",
    ),
  );
  await NodeVM.runInNewContext(`${source}\ngoatMcpExtension(pi)`, {
    process: { env: {} },
    pi: { on: (name: string, handler: RequestHook) => handlers.set(name, handler) },
  });
  const hook = handlers.get("before_provider_request");
  assert.isDefined(hook);
  return hook!;
}

describe("Pi upstream output-budget workaround", () => {
  it.each(["max_tokens", "max_completion_tokens"])(
    "caps %s without changing the conversation or tools",
    async (key) => {
      const hook = await loadRequestHook();
      const payload = {
        model: "moonshotai/kimi-k2.6",
        messages: [{ role: "user", content: "hello" }],
        tools: [{ type: "function", function: { name: "read" } }],
        [key]: 231_969,
      };
      const result = hook({ payload }, { model: { provider: "openrouter" } });
      assert.equal(result?.[key], 32_768);
      assert.strictEqual(result?.messages, payload.messages);
      assert.strictEqual(result?.tools, payload.tools);
      assert.equal(result?.model, payload.model);
      assert.equal(payload[key], 231_969);
    },
  );

  it("preserves smaller budgets and other providers' payloads", async () => {
    const hook = await loadRequestHook();
    for (const payload of [{ max_tokens: 8192 }, { max_completion_tokens: 32_768 }, {}, null]) {
      assert.isUndefined(hook({ payload }, { model: { provider: "openrouter" } }));
    }
    assert.isUndefined(
      hook({ payload: { max_tokens: 231_969 } }, { model: { provider: "anthropic" } }),
    );
  });
});

async function loadInputHook(commands: ReadonlyArray<SkillCommand>) {
  const handlers = await loadHooks(commands);
  const hook = handlers.get("input");
  assert.isDefined(hook);
  return hook as InputHook;
}

describe("Pi skill references", () => {
  it("loads every selected skill once while preserving inline prose, whitespace, and images", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-skill-mentions-"));
    try {
      const alpha = NodePath.join(directory, "alpha.md");
      const beta = NodePath.join(directory, "beta.md");
      await NodeFSP.writeFile(alpha, "ALPHA_INSTRUCTIONS");
      await NodeFSP.writeFile(beta, "BETA_INSTRUCTIONS");
      const hook = await loadInputHook([
        { name: "skill:alpha", source: "skill", sourceInfo: { path: alpha } },
        { name: "skill:beta", source: "skill", sourceInfo: { path: beta } },
      ]);
      const text =
        "Please use the $alpha philosophy, then $beta and $alpha\n```ts\n  const x = 1;\n```";
      const images = [{ type: "image", data: "fixture" }];
      const result = await hook({ text, images }, { ui: { notify: assert.fail } });
      assert.equal(result?.action, "transform");
      assert.isTrue(result?.text.startsWith(text + "\n\n"));
      assert.equal(result?.text.split("ALPHA_INSTRUCTIONS").length, 2);
      assert.equal(result?.text.split("BETA_INSTRUCTIONS").length, 2);
      assert.include(result?.text ?? "", `References are relative to ${directory}.`);
      assert.strictEqual(result?.images, images);
    } finally {
      await NodeFSP.rm(directory, { recursive: true });
    }
  });

  it("leaves unknown references and native skill commands for Pi", async () => {
    const hook = await loadInputHook([
      { name: "skill:alpha", source: "skill", sourceInfo: { path: "/unused" } },
    ]);
    for (const text of [
      "Explain $HOME",
      "/skill:alpha use $alpha",
      "Hello",
      "$missing",
      "Use $alpha, then continue",
      "Use ($alpha)",
    ]) {
      assert.isUndefined(await hook({ text }, { ui: { notify: assert.fail } }));
    }
  });

  it("loads additional chips without duplicating a leading native skill", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-skill-mentions-"));
    try {
      const path = NodePath.join(directory, "beta.md");
      await NodeFSP.writeFile(path, "BETA_INSTRUCTIONS");
      const hook = await loadInputHook([
        { name: "skill:alpha", source: "skill", sourceInfo: { path: "/unused" } },
        { name: "skill:beta", source: "skill", sourceInfo: { path } },
      ]);
      const text = "/skill:alpha use $alpha and $beta";
      const result = await hook({ text }, { ui: { notify: assert.fail } });
      assert.isTrue(result?.text.startsWith(text + "\n\n"));
      assert.notInclude(result?.text ?? "", '<skill name="alpha"');
      assert.include(result?.text ?? "", "BETA_INSTRUCTIONS");
    } finally {
      await NodeFSP.rm(directory, { recursive: true });
    }
  });

  it("reports an unreadable skill without deleting its reference or other selected instructions", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-skill-mentions-"));
    try {
      const path = NodePath.join(directory, "readable.md");
      await NodeFSP.writeFile(path, "READABLE_INSTRUCTIONS");
      const hook = await loadInputHook([
        {
          name: "skill:missing",
          source: "skill",
          sourceInfo: { path: NodePath.join(directory, "missing.md") },
        },
        { name: "skill:readable", source: "skill", sourceInfo: { path } },
      ]);
      const notices: string[] = [];
      const text = "Use $missing and $readable";
      const result = await hook(
        { text },
        {
          ui: {
            notify: (message) => {
              notices.push(message);
            },
          },
        },
      );
      assert.isTrue(result?.text.startsWith(text + "\n\n"));
      assert.include(result?.text ?? "", "READABLE_INSTRUCTIONS");
      assert.equal(notices.length, 1);
      assert.include(notices[0] ?? "", "Could not load skill missing");
    } finally {
      await NodeFSP.rm(directory, { recursive: true });
    }
  });
});
const FAKE_CUA_DRIVER = `import * as NodeReadline from "node:readline";
NodeReadline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const result =
    message.method === "initialize"
      ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } }
      : message.method === "tools/list"
        ? { tools: [{ name: "get_window_state", description: "Capture a window.\\nWithout raising it.", inputSchema: { type: "object", properties: { window_id: { type: "number" } } } }] }
        : { content: [{ type: "text", text: "window " + message.params.arguments.window_id }, { type: "image", data: "AAAA", mimeType: "image/png" }] };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
});
`;

describe("Pi Cua Driver bridge", () => {
  it("bridges a stdio driver's tools with screenshots and adds the computer use instructions", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-pi-cua-"));
    try {
      const script = NodePath.join(directory, "fake-cua-driver.mjs");
      await NodeFSP.writeFile(script, FAKE_CUA_DRIVER);
      const bridge = await loadMcpBridge({ cua: { command: process.execPath, args: [script] } });
      try {
        const tool = bridge.tools.find(
          (entry) => entry.name === "mcp__cua-driver__get_window_state",
        );
        assert.equal(tool?.promptSnippet, "Capture a window.");
        const output = await tool!.execute("capture", { window_id: 7 });
        assert.deepEqual(output.content, [
          { type: "text", text: "window 7" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ]);
        assert.deepEqual(output.details, { server: "cua-driver", tool: "get_window_state" });
        const start = bridge.handlers.get("before_agent_start")!;
        const ctx = { ui: { notify: () => undefined } };
        // Pi renders named sections; a full prompt override falls back to appending.
        const sections: Record<string, string> = {};
        assert.isUndefined(
          await start({ systemPrompt: "base", systemPromptOptions: { sections } }, ctx),
        );
        assert.include(sections.goat_computer_use, "<computer_use>");
        assert.include(
          (await start({ systemPrompt: "base" }, ctx))?.systemPrompt,
          "<computer_use>",
        );
      } finally {
        await (bridge.handlers.get("session_shutdown") as unknown as () => void)();
      }
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("closes the driver for a turn its gate shuts, and reopens it when the gate opens", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-pi-cua-gate-"));
    try {
      const script = NodePath.join(directory, "fake-cua-driver.mjs");
      const gate = NodePath.join(directory, "gate");
      await NodeFSP.writeFile(script, FAKE_CUA_DRIVER);
      await NodeFSP.writeFile(gate, "on");
      const bridge = await loadMcpBridge({
        cua: { command: process.execPath, args: [script] },
        cuaGate: gate,
      });
      const name = "mcp__cua-driver__get_window_state";
      const tool = bridge.tools.find((entry) => entry.name === name)!;
      const start = bridge.handlers.get("before_agent_start")!;
      const ctx = { ui: { notify: () => undefined } };
      const turn = async () => {
        const sections: Record<string, string> = {};
        await start({ systemPrompt: "base", systemPromptOptions: { sections } }, ctx);
        return sections;
      };
      try {
        bridge.restoreActiveTools(["read", name]);
        assert.include((await turn()).goat_computer_use, "<computer_use>");

        // A Plan or read-only turn: the adapter shuts the gate before the prompt.
        await NodeFSP.writeFile(gate, "off");
        assert.isUndefined((await turn()).goat_computer_use);
        assert.notInclude(bridge.getActiveTools(), name);
        const refused = await tool.execute("capture", { window_id: 7 });
        assert.isTrue(refused.isError);
        assert.deepEqual(refused.content, [
          { type: "text", text: "Computer use is off for this turn." },
        ]);

        // A missing gate fails closed.
        await NodeFSP.rm(gate);
        assert.isUndefined((await turn()).goat_computer_use);

        await NodeFSP.writeFile(gate, "on");
        assert.include((await turn()).goat_computer_use, "<computer_use>");
        assert.include(bridge.getActiveTools(), name);
        // The closed connection starts again with a fresh handshake.
        const output = await tool.execute("capture", { window_id: 8 });
        assert.deepEqual(output.content[0], { type: "text", text: "window 8" });
      } finally {
        await (bridge.handlers.get("session_shutdown") as unknown as () => void)();
      }
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("leaves the instructions out of a session without the driver", async () => {
    const bridge = await loadMcpBridge();
    assert.isFalse(bridge.tools.some((entry) => entry.name.startsWith("mcp__cua-driver__")));
    const start = bridge.handlers.get("before_agent_start")!;
    const ctx = { ui: { notify: () => undefined } };
    const sections: Record<string, string> = {};
    await start({ systemPrompt: "base", systemPromptOptions: { sections } }, ctx);
    assert.isUndefined(sections.goat_computer_use);
    assert.notInclude((await start({ systemPrompt: "base" }, ctx))?.systemPrompt, "<computer_use>");
  });
});

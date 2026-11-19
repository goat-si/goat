import { EnvironmentId, ThreadId } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import { GOAT_MEMORY_TOOLS } from "./CodexAdapterV2.attachment.testkit.ts";

const decodeRegular = Schema.decodeUnknownSync(
  Schema.Struct({ disabled_tools: Schema.Array(Schema.String) }),
);
const decodeDirect = Schema.decodeUnknownSync(
  Schema.Struct({
    enabled_tools: Schema.Array(Schema.String),
    omit_tools_from: Schema.Array(Schema.String),
  }),
);

it("registers task creation directly while keeping memory tools scoped", () => {
  const params = CodexAdapterV2.codexThreadRuntimeParams({
    mcpSession: {
      environmentId: EnvironmentId.make("fixture"),
      threadId: ThreadId.make("thread-direct-task"),
      providerSessionId: "fixture",
      providerInstanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
      endpoint: "http://127.0.0.1:1/mcp",
      authorizationHeader: "Bearer fixture",
      browserToolsAvailable: false,
      grantedScopes: [],
    },
  });
  const regular = decodeRegular(params.config["mcp_servers.goat"]);
  const direct = decodeDirect(params.config["mcp_servers.goat-direct"]);
  assert.include(regular.disabled_tools, "goat_task_create");
  assert.include(direct.enabled_tools, "goat_task_create");
  assert.deepEqual(direct.omit_tools_from, ["code_mode", "deferred"]);
  for (const name of GOAT_MEMORY_TOOLS) assert.include(regular.disabled_tools, name);
});

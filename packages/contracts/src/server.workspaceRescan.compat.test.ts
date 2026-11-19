import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import { ServerProvider as OldServerProvider } from "./server.u39Base.testkit.ts";
import { ServerProvider } from "./server.ts";

const decodeOld = Schema.decodeSync(OldServerProvider);
const decodeNew = Schema.decodeUnknownSync(ServerProvider);

it("decodes workspace rescan notifications across old and new provider schemas", () => {
  const base = {
    instanceId: "codex",
    driver: "codex",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-04-10T00:00:00.000Z",
    models: [],
  };
  const timestamp = "2026-11-20T00:00:00.000Z";
  const newProvider = decodeNew({ ...base, workspaceRescannedAt: timestamp });
  expect(Reflect.get(newProvider, "workspaceRescannedAt")).toBe(timestamp);
  expect(decodeOld(newProvider)).not.toHaveProperty("workspaceRescannedAt");
  expect(decodeNew(base)).not.toHaveProperty("workspaceRescannedAt");
});

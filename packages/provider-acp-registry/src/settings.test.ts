import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import { AcpRegistrySettings, isMiniMaxCode } from "./settings.ts";

it("does not grant MiniMax Code credential use to existing settings", () => {
  const config = { source: "local", commandPath: "/installed/mcode", commandArgs: ["acp"] };
  const decode = Schema.decodeUnknownSync(AcpRegistrySettings);
  const before = decode(config);
  expect(isMiniMaxCode(before)).toBe(true);
  expect(before.readMiniMaxCodeQuota).toBe(false);
  expect(decode({ ...config, readMiniMaxCodeQuota: true }).readMiniMaxCodeQuota).toBe(true);
});

import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ServerSettings } from "./settings.ts";
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);

it("defaults inactive settlement to seven days while keeping explicit values", () => {
  expect(decodeServerSettings({}).sidebarAutoSettleAfterDays).toBe(7);
  expect(decodeServerSettings({ sidebarAutoSettleAfterDays: 3 }).sidebarAutoSettleAfterDays).toBe(
    3,
  );
  expect(
    decodeServerSettings({ sidebarAutoSettleAfterDays: null }).sidebarAutoSettleAfterDays,
  ).toBeNull();
});

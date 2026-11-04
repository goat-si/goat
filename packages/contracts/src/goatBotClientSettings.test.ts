import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import { ClientSettingsPatch, ClientSettingsSchema } from "./settings.ts";

const decode = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodePatch = Schema.decodeUnknownSync(ClientSettingsPatch);

it("defaults task threads beside chat while preserving an explicit client preference", () => {
  expect(decode({}).goatBotTaskThreadsBesideChat).toBe(true);
  expect(decode({ goatBotTaskThreadsBesideChat: false }).goatBotTaskThreadsBesideChat).toBe(false);
  expect(decodePatch({ goatBotTaskThreadsBesideChat: false })).toEqual({
    goatBotTaskThreadsBesideChat: false,
  });
});

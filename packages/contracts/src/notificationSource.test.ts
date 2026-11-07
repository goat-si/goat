import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

import { OrchestrationV2NotificationSource } from "./orchestrationV2.ts";

const decode = Schema.decodeUnknownSync(OrchestrationV2NotificationSource);
const encode = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2NotificationSource));

it("keeps GOAT Bot event lines as their own source for new clients", () => {
  const source = { kind: "goat_bot_event" as const };
  expect(decode(encode(source))).toEqual(source);
});

import * as Effect from "effect/Effect";

import * as McpToolAccess from "../../McpToolAccess.ts";
import { MessageToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(MessageToolkit, {
  goat_message_show: McpToolAccess.readsAsCaller(({ message }) =>
    Effect.succeed({ sentMessage: message, message: "Shown to the user. Don't repeat it." }),
  ),
});

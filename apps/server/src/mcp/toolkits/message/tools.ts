import { OrchestratorMcpFailure } from "@goat/contracts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { SENT_MESSAGE_MAX_LENGTH } from "@goat/shared/toolOutput";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const show = agentSurfaceRegistry["message.show"];

const ShowMessageTool = Tool.make(show.name, {
  description: show.description,
  parameters: Schema.Struct({
    message: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(SENT_MESSAGE_MAX_LENGTH),
      Schema.makeFilter((message) => message.trim().length > 0 || "Provide nonblank Markdown."),
    ).annotate({ description: "Markdown shown verbatim." }),
  }),
  success: Schema.Struct({ sentMessage: Schema.String, message: Schema.String }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
}).annotateMerge(agentSurfaceAnnotations(show));

export const MessageToolkit = Toolkit.make(ShowMessageTool);

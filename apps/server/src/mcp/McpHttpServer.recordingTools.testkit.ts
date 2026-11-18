import { OrchestratorMcpFailure } from "@goat/contracts";
import { Toolkit } from "effect/ai";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import { ProjectToolkit } from "./toolkits/project/tools.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadResultService from "../threadResults/ThreadResultService.ts";
import * as HostThreadsMcpService from "./HostThreadsMcpService.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

export const layerRecordingTools = (calls: Array<unknown>) => {
  const RecordingToolkit = Toolkit.make(
    OrchestratorToolkit.tools.delegate_task,
    OrchestratorToolkit.tools.goat_thread_read,
    OrchestratorToolkit.tools.goat_thread_wait,
    ProjectToolkit.tools.goat_project_update,
  );
  const record = McpToolAccess.reads((params: unknown) =>
    Effect.sync(() => calls.push(params)).pipe(
      Effect.andThen(
        Effect.fail(new OrchestratorMcpFailure({ code: "thread_not_found", message: "Recorded." })),
      ),
    ),
  );
  return McpHttpServer.toolkitRegistration(
    RecordingToolkit,
    McpToolAccess.toLayer(RecordingToolkit, {
      delegate_task: record,
      goat_thread_read: record,
      goat_thread_wait: record,
      goat_project_update: record,
    }),
  ).pipe(
    Layer.provide(McpToolAccessTestkit.layerPermissionProfilesOff),
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provide(
      Layer.mergeAll(
        McpToolAccessTestkit.liveThreadsLayer,
        Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(HostThreadsMcpService.HostThreadsMcpService)({}),
        Layer.mock(ThreadResultService.ThreadResultService)({}),
        NodeServices.layer,
        NodeCrypto.layer,
      ),
    ),
  );
};

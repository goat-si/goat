import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";
import * as M from "@goat/contracts";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import { Tool, Toolkit } from "effect/ai";
import * as MemoryService from "../../../memory/MemoryService.ts";
import * as MemorySyncService from "../../../memory/MemorySyncService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/** JSON Schema presentation only; handlers still decode the original strict contracts. */
export const memoryInputSchema = (schema: Schema.Top) => {
  const expose = (ast: SchemaAST.AST): SchemaAST.AST => {
    if (ast._tag === "Declaration" && ast.typeParameters.length === 1)
      return expose(ast.typeParameters[0]!);
    if (ast._tag === "Objects")
      return new SchemaAST.Objects(
        ast.propertySignatures.map(
          (field) => new SchemaAST.PropertySignature(field.name, expose(field.type)),
        ),
        ast.indexSignatures.map(
          (field) => new SchemaAST.IndexSignature(expose(field.parameter), expose(field.type)),
        ),
        ast.annotations,
        ast.checks,
        ast.encoding,
        ast.context,
      );
    if (ast._tag === "Arrays")
      return new SchemaAST.Arrays(
        ast.isMutable,
        ast.elements.map(expose),
        ast.rest.map(expose),
        ast.annotations,
        ast.checks,
        ast.encoding,
        ast.context,
      );
    if (ast._tag === "Union")
      return new SchemaAST.Union(
        ast.types.map(expose),
        ast.options,
        ast.annotations,
        ast.checks,
        ast.encoding,
        ast.context,
      );
    if (ast._tag === "Suspend")
      return new SchemaAST.Suspend(
        () => expose(ast.thunk()),
        ast.annotations,
        ast.checks,
        ast.encoding,
        ast.context,
      );
    return ast;
  };
  const document = Schema.toJsonSchemaDocument(Schema.make(expose(schema.ast)), {
    onExcessProperty: "error",
  });
  return {
    ...document.schema,
    type: "object" as const,
    ...(Object.keys(document.definitions).length === 0 ? {} : { $defs: document.definitions }),
  };
};

const failure = Schema.Union([M.MemoryRpcError, M.OrchestratorMcpFailure]);
const SearchTool = Tool.dynamic(agentSurfaceRegistry["memory.search"].name, {
  description: agentSurfaceRegistry["memory.search"].description,
  parameters: memoryInputSchema(M.MemorySearchInput),
  success: M.MemoryPage,
  failure,
  failureMode: "return",
})
  .addDependency(McpInvocationContext.McpInvocationContext)
  .addDependency(MemoryService.MemoryService)
  .addDependency(MemorySyncService.MemorySyncService)
  .addDependency(ThreadManagementService.ThreadManagementService)
  .annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["memory.search"]));

const ListTool = Tool.dynamic(agentSurfaceRegistry["memory.list"].name, {
  description: agentSurfaceRegistry["memory.list"].description,
  parameters: memoryInputSchema(M.MemoryListInput),
  success: M.MemoryPage,
  failure,
  failureMode: "return",
})
  .addDependency(McpInvocationContext.McpInvocationContext)
  .addDependency(MemoryService.MemoryService)
  .addDependency(MemorySyncService.MemorySyncService)
  .addDependency(ThreadManagementService.ThreadManagementService)
  .annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["memory.list"]));

const ReadTool = Tool.dynamic(agentSurfaceRegistry["memory.read"].name, {
  description: agentSurfaceRegistry["memory.read"].description,
  parameters: memoryInputSchema(M.MemoryReadInput),
  success: M.MemoryItem,
  failure,
  failureMode: "return",
})
  .addDependency(McpInvocationContext.McpInvocationContext)
  .addDependency(MemoryService.MemoryService)
  .addDependency(MemorySyncService.MemorySyncService)
  .addDependency(ThreadManagementService.ThreadManagementService)
  .annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["memory.read"]));

const HistoryTool = Tool.dynamic(agentSurfaceRegistry["memory.history"].name, {
  description: agentSurfaceRegistry["memory.history"].description,
  parameters: memoryInputSchema(M.MemoryHistoryInput),
  success: M.MemoryHistoryPage,
  failure,
  failureMode: "return",
})
  .addDependency(McpInvocationContext.McpInvocationContext)
  .addDependency(MemoryService.MemoryService)
  .addDependency(MemorySyncService.MemorySyncService)
  .addDependency(ThreadManagementService.ThreadManagementService)
  .annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["memory.history"]));

const SyncStatusTool = Tool.dynamic(agentSurfaceRegistry["memory.sync_status"].name, {
  description: agentSurfaceRegistry["memory.sync_status"].description,
  parameters: memoryInputSchema(M.MemorySyncStatusInput),
  success: M.MemorySyncStatus,
  failure,
  failureMode: "return",
})
  .addDependency(McpInvocationContext.McpInvocationContext)
  .addDependency(MemoryService.MemoryService)
  .addDependency(MemorySyncService.MemorySyncService)
  .addDependency(ThreadManagementService.ThreadManagementService)
  .annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["memory.sync_status"]));

const UpsertTool = Tool.dynamic(agentSurfaceRegistry["memory.upsert"].name, {
  description: agentSurfaceRegistry["memory.upsert"].description,
  parameters: memoryInputSchema(M.MemoryUpsertInput),
  success: M.MemoryMutationReceipt,
  failure,
  failureMode: "return",
})
  .addDependency(McpInvocationContext.McpInvocationContext)
  .addDependency(MemoryService.MemoryService)
  .addDependency(MemorySyncService.MemorySyncService)
  .addDependency(ThreadManagementService.ThreadManagementService)
  .annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["memory.upsert"]));

const ForgetTool = Tool.dynamic(agentSurfaceRegistry["memory.forget"].name, {
  description: agentSurfaceRegistry["memory.forget"].description,
  parameters: memoryInputSchema(M.MemoryForgetInput),
  success: M.MemoryMutationReceipt,
  failure,
  failureMode: "return",
})
  .addDependency(McpInvocationContext.McpInvocationContext)
  .addDependency(MemoryService.MemoryService)
  .addDependency(MemorySyncService.MemorySyncService)
  .addDependency(ThreadManagementService.ThreadManagementService)
  .annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["memory.forget"]));

const RevertResolutionTool = Tool.dynamic(agentSurfaceRegistry["memory.revert_resolution"].name, {
  description: agentSurfaceRegistry["memory.revert_resolution"].description,
  parameters: memoryInputSchema(M.MemoryRevertResolutionInput),
  success: M.MemoryRevertResult,
  failure,
  failureMode: "return",
})
  .addDependency(McpInvocationContext.McpInvocationContext)
  .addDependency(MemoryService.MemoryService)
  .addDependency(MemorySyncService.MemorySyncService)
  .addDependency(ThreadManagementService.ThreadManagementService)
  .annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["memory.revert_resolution"]));

const ReadSourceTool = Tool.dynamic(agentSurfaceRegistry["memory.source_read"].name, {
  description: agentSurfaceRegistry["memory.source_read"].description,
  parameters: memoryInputSchema(M.MemoryReadSourceInput),
  success: M.MemorySourcePage,
  failure,
  failureMode: "return",
})
  .addDependency(McpInvocationContext.McpInvocationContext)
  .addDependency(MemoryService.MemoryService)
  .addDependency(MemorySyncService.MemorySyncService)
  .addDependency(ThreadManagementService.ThreadManagementService)
  .annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["memory.source_read"]));

export const MemoryToolkit = Toolkit.make(
  SearchTool,
  ListTool,
  ReadTool,
  HistoryTool,
  SyncStatusTool,
  UpsertTool,
  ForgetTool,
  RevertResolutionTool,
  ReadSourceTool,
);

import { expect, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as MemoryService from "../../../memory/MemoryService.ts";
import { advertisedJsonSchema } from "../../advertisedJsonSchema.ts";
import * as Fixture from "./handlers.testkit.ts";
import { MemoryToolkit } from "./tools.ts";

const decodeHistory = Schema.decodeUnknownEffect(M.MemoryHistoryPage);
const decodeRefusal = Schema.decodeUnknownEffect(M.OrchestratorMcpFailure);

it("advertises the memory history opt-in as an optional boolean without an enum", () => {
  const schema = advertisedJsonSchema(MemoryToolkit.tools.memory_history);
  expect(schema.properties).toMatchObject({ includeRefusedReverts: { type: "boolean" } });
  expect(schema.properties).not.toHaveProperty("includeRefusedReverts.enum");
  expect(schema.required).not.toContain("includeRefusedReverts");
});

it.effect("only exposes refused reverts over MCP on explicit opt-in (#3791)", () =>
  Effect.gen(function* () {
    const service = yield* MemoryService.MemoryService;
    const sql = yield* SqlClient.SqlClient;
    const saved = yield* service.upsert(Fixture.upsert(), Effect.void);
    if (!("revisionId" in saved.receipt) || !saved.receipt.revisionId)
      throw new Error("fixture revision missing");
    const revisionId = saved.receipt.revisionId;
    const resolutionId = M.MemoryResolutionId.make(Fixture.id(4));
    const operationId = M.MemoryOperationId.make(Fixture.id(5));
    const inputs = [revisionId, M.MemoryRevisionId.make(Fixture.id(6))].sort();
    const selection = { instanceId: "fixture", model: "fixture" };
    const resolution = {
      resolutionId,
      memorySpaceId: Fixture.space,
      memoryId: Fixture.memoryId,
      inputRevisionIds: inputs,
      inputPayloadRefs: inputs,
      judgmentRef: resolutionId,
      requestedModelSelection: selection,
      effectiveProvider: "codex",
      effectiveModel: "fixture",
      resolvingEnvironmentId: "fixture-memory-mcp",
      fencingToken: 1,
      resultRevisionId: revisionId,
      appliedAtUtc: "2026-10-14T00:00:00.000Z",
      revertDeadlineUtc: "2026-11-13T00:00:00.000Z",
    };
    yield* sql`INSERT INTO memory_resolutions(space,resolution_id,memory_id,input_revision_ids_json,input_payload_refs_json,judgment_payload_ref,requested_model_selection_json,effective_provider_model_json,resolving_environment_id,fencing_token,result_revision_id,applied_at,revert_deadline,resolution_json,revert_operation_id,revert_result_json)
      VALUES (${Fixture.space},${resolutionId},${Fixture.memoryId},${JSON.stringify(inputs)},${JSON.stringify(inputs)},${resolutionId},${JSON.stringify(selection)},'{}','fixture-memory-mcp',1,${revisionId},0,0,${JSON.stringify(resolution)},${operationId},'{"status":"refused","failureCode":"unavailable"}')`;
    const args = { memoryId: Fixture.memoryId };
    const omitted = yield* Fixture.call("goat_memory_history", args);
    expect((yield* decodeHistory(omitted.body)).revertResults).toEqual([]);

    const declined = yield* Fixture.call("goat_memory_history", {
      ...args,
      includeRefusedReverts: false,
    });
    expect(declined.result.isError).not.toBe(true);
    expect(declined.body).toEqual(omitted.body);

    const optedIn = yield* Fixture.call("goat_memory_history", {
      ...args,
      includeRefusedReverts: true,
    });
    expect((yield* decodeHistory(optedIn.body)).revertResults).toMatchObject([
      { operationId, resolutionId, status: "refused", failureCode: "unavailable" },
    ]);

    const denied = yield* Fixture.call(
      "goat_memory_history",
      {
        ...args,
        includeRefusedReverts: true,
      },
      Fixture.scope([]),
    );
    expect(denied.result.isError).toBe(true);
    expect(denied.body).toMatchObject({ code: "unavailable" });

    const invalid = yield* Fixture.call("goat_memory_history", {
      ...args,
      includeRefusedReverts: "false",
    });
    expect((yield* decodeRefusal(invalid.body)).code).toBe("invalid_request");
  }).pipe(Effect.provide(Fixture.layer)),
);

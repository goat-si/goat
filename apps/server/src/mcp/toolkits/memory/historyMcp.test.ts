import { expect, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
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

it.effect("treats a false memory history opt-in like omission over MCP", () =>
  Effect.gen(function* () {
    const service = yield* MemoryService.MemoryService;
    yield* service.upsert(Fixture.upsert(), Effect.void);
    const args = { memoryId: Fixture.memoryId };
    const omitted = yield* Fixture.call("goat_memory_history", args);
    expect((yield* decodeHistory(omitted.body)).revisions).toHaveLength(1);

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
    expect((yield* decodeHistory(optedIn.body)).revisions).toHaveLength(1);

    const invalid = yield* Fixture.call("goat_memory_history", {
      ...args,
      includeRefusedReverts: "false",
    });
    expect((yield* decodeRefusal(invalid.body)).code).toBe("invalid_request");
  }).pipe(Effect.provide(Fixture.layer)),
);

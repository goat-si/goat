import { assert, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";
import { runLoad } from "./serverLoad.ts";

const rpc = vi.hoisted(() => ({ make: vi.fn() }));
class CreateRefused extends Data.TaggedError("CreateRefused")<{ readonly message: string }> {}
vi.mock("effect/rpc/RpcClient", () => ({
  make: rpc.make,
  layerProtocolSocket: () => Layer.empty,
}));

it("returns successful and failed operation measurements when a later request fails", async () => {
  rpc.make.mockReturnValue(
    Effect.succeed({
      "server.getConfig": () => Effect.succeed({}),
      "orchestration.getThreadProjection": () =>
        Effect.succeed({ messages: [{ text: "fixture simple ok" }] }),
      "orchestration.dispatchCommand": () =>
        Effect.fail(new CreateRefused({ message: "create refused" })),
    }),
  );
  using _fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (url) =>
      String(url).endsWith("browser-session")
        ? new Response(null, { headers: { "set-cookie": "fixture=session; HttpOnly" } })
        : Response.json({ ticket: "fixture-ticket", expiresAt: "2030-01-01T00:00:00.000Z" }),
    );

  const result = await runLoad("http://fixture.invalid", "fixture-credential", 3);

  assert.deepEqual(result.operations.config, { offered: 1, completed: 1, failed: 0, errors: [] });
  assert.equal(result.operations.create?.offered, 1);
  assert.equal(result.operations.create?.completed, 0);
  assert.equal(result.operations.create?.failed, 1);
  assert.include(result.operations.create?.errors[0] ?? "", "create refused");
  assert.include(result.error ?? "", "create refused");
  for (const kind of ["config", "create"]) {
    const latency = result.latencies[kind];
    assert.equal(latency?.status, "available");
    if (latency?.status === "available") assert.equal(latency.value.count, 1);
  }
});

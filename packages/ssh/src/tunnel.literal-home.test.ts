import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { makeProtocolFixture } from "./tunnel.protocol.fixture.ts";

it.live("adopts a retained SSH runner when the remote home contains a newline", () =>
  Effect.gen(function* () {
    const f = yield* makeProtocolFixture({
      live: true,
      kind: "managed",
      oldVersion: "1.2.2",
      ssh: SSH_RUNTIME_PROTOCOL_VERSION,
      orchestration: ORCHESTRATION_PROTOCOL_VERSION,
      homePrefix: "goat-home\nnewline-",
    });
    const before = yield* f.snapshot;
    const result = yield* f.run("pairing");
    assert.isTrue(Result.isSuccess(result));
    if (Result.isSuccess(result)) assert.equal(result.success.version, "1.2.2");
    assert.deepEqual(yield* f.snapshot, before);
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
);

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type {
  EnvironmentId,
  ThreadId,
  ProviderInstanceId,
  ScreenHostCall,
  ScreenImageMetadata,
  ScreenImage,
} from "@goat/contracts";
import { ScreenHostBridge } from "./ScreenHostBridge.ts";
import { screenRunLimits } from "./ScreenRunLimits.ts";

const context = () => ({
  runId: "r",
  turnId: "t",
  cellId: "c",
  threadId: "thread",
  environmentId: "env",
  limits: screenRunLimits({ imageBytes: 100 }),
  invocation: {
    environmentId: "env" as EnvironmentId,
    capabilities: new Set(["preview" as const]),
    issuedAt: 0,
    requestNamespace: "test",
    client: undefined,
    thread: {
      threadId: "thread" as ThreadId,
      providerSessionId: "s",
      providerInstanceId: "p" as ProviderInstanceId,
    },
    reauthorize: () => Effect.void,
  },
});
const call = (callId: number): ScreenHostCall => ({
  t: "call",
  runId: "r",
  turnId: "t",
  cellId: "c",
  callId,
  targetRef: {
    id: "target",
    kind: "tab",
    environmentId: "env",
    runId: "r",
    turnId: "t",
    generation: 0,
  },
  method: "screenshot",
  args: {},
  deadlineMillis: 60_000,
});

it.effect("identical images in a cell are emitted once while each capture keeps its region", () =>
  Effect.gen(function* () {
    const bridge = new ScreenHostBridge();
    bridge.setDispatcher({
      availability: () => Effect.succeed([{ kind: "tab", available: true }]),
      dispatch: (request) => {
        const metadata: ScreenImageMetadata = {
          imageRef: `i${request.callId}`,
          callId: request.callId,
          targetId: "target",
          observationId: `o${request.callId}`,
          regionId: `g${request.callId}`,
          region: { kind: "viewport", x: 0, y: 0, width: 1, height: 1 },
          pixelWidth: 1,
          pixelHeight: 1,
          scale: 1,
          mimeType: "image/png",
        };
        const image: ScreenImage = { ...metadata, bytes: Buffer.from("same").toString("base64") };
        return Effect.succeed({
          value: metadata,
          image,
          imageMetadata: metadata,
          category: "unverifiable" as const,
        });
      },
    });
    yield* bridge.handle({ ...call(1), method: "screenshot" }, context());
    const second = yield* bridge.handle({ ...call(2), method: "screenshot" }, context());
    const collected = yield* bridge.takeCellImages("r", "t", "c");
    expect(collected.images).toHaveLength(1);
    expect(second?.value).toMatchObject({ imageRef: "i1", regionId: "g2", observationId: "o2" });
  }),
);

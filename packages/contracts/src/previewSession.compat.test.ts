import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ComputerUseOverlayPoint } from "./computerUseOverlay.ts";
import { ComputerUseRefusalReason } from "./computerUseProtocol.ts";
import { PreviewSessionsSnapshot } from "./previewSession.ts";

// The snapshot shape origin/dev clients decode (git show origin/dev:packages/contracts/src/previewSession.ts),
// copied here so a mixed-version pair keeps its preview tiles.
const OldDesktopTarget = Schema.Struct({
  kind: Schema.Literal("desktop"),
  bundleId: Schema.optionalKey(TrimmedNonEmptyString),
  pid: Schema.optionalKey(Schema.Int),
  windowId: Schema.optionalKey(Schema.Int),
  title: Schema.String,
  cursor: Schema.optionalKey(
    Schema.Struct({
      windowId: Schema.Int,
      point: ComputerUseOverlayPoint,
      phase: Schema.Literals(["acting", "resting"]),
    }),
  ),
});
const OldPreviewSessionsSnapshot = Schema.Struct({
  sessions: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      kind: Schema.Literals(["browser", "desktop"]),
      environmentId: EnvironmentId,
      host: Schema.String,
      platform: Schema.Literals(["mac", "windows", "linux"]),
      threadId: Schema.optionalKey(ThreadId),
      target: Schema.Union([
        Schema.Struct({
          kind: Schema.Literal("browser"),
          tabId: TrimmedNonEmptyString,
          url: Schema.String,
          title: Schema.String,
        }),
        OldDesktopTarget,
      ]),
      owner: Schema.Literals(["agent", "human", "private"]),
      status: Schema.Literals([
        "idle",
        "observing",
        "acting",
        "waiting-for-human",
        "paused",
        "stopped",
        "error",
        "permission-needed",
      ]),
      reason: Schema.optionalKey(ComputerUseRefusalReason),
      handoffReason: Schema.optionalKey(Schema.String),
      lease: Schema.optionalKey(
        Schema.Struct({
          threadId: ThreadId,
          expiresAt: Schema.String,
          scope: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
        }),
      ),
      lastFrame: Schema.optionalKey(TrimmedNonEmptyString),
      capabilities: Schema.Struct({
        controls: Schema.Array(
          Schema.Literals(["takeover", "handBack", "requestHandoff", "stop", "stopAll"]),
        ),
        frames: Schema.Boolean,
        privateMode: Schema.Boolean,
        humanInput: Schema.Boolean,
      }),
    }),
  ),
});

const decodeCurrent = Schema.decodeUnknownSync(PreviewSessionsSnapshot);
const encodeCurrent = Schema.encodeSync(PreviewSessionsSnapshot);
const decodeOld = Schema.decodeUnknownSync(OldPreviewSessionsSnapshot);

const oldSession = {
  id: "desktop-1",
  kind: "desktop",
  environmentId: "environment-1",
  host: "host",
  platform: "mac",
  target: {
    kind: "desktop",
    title: "Window",
    windowId: 9,
    cursor: { windowId: 9, point: { fx: 0.5, fy: 0.5 }, phase: "resting" },
  },
  owner: "agent",
  status: "acting",
  capabilities: {
    controls: ["stop", "takeover"],
    frames: true,
    privateMode: false,
    humanInput: true,
  },
} as const;

describe("preview session snapshots across client and server versions", () => {
  it("an origin/dev server's snapshot decodes on a new client without motionSupport", () => {
    const target = decodeCurrent({ sessions: [oldSession] }).sessions[0]?.target;
    expect(target).toMatchObject({ kind: "desktop", windowId: 9 });
    expect(target && "motionSupport" in target).toBe(false);
  });

  it("a new server's snapshot decodes on an origin/dev client, with new phases only in cursorState", () => {
    const sent = encodeCurrent(
      decodeCurrent({
        sessions: [
          {
            ...oldSession,
            target: {
              ...oldSession.target,
              cursor: { windowId: 9, point: { fx: 0.5, fy: 0.5 }, phase: "acting" },
              motionSupport: "supported",
              cursorState: {
                identity: {
                  environmentId: "environment-1",
                  runId: "run",
                  turnId: "turn",
                  targetId: "target",
                  generation: 1,
                  sequence: 2,
                },
                phase: "moving",
              },
            },
          },
        ],
      }),
    );
    expect(decodeOld(sent).sessions[0]?.target).toMatchObject({
      kind: "desktop",
      cursor: { phase: "acting" },
    });
  });

  it("the old cursor field refuses phases origin/dev clients cannot decode", () => {
    const moving = {
      ...oldSession,
      target: {
        ...oldSession.target,
        cursor: { ...oldSession.target.cursor, phase: "moving" },
      },
    };
    expect(() => decodeCurrent({ sessions: [moving] })).toThrow();
    expect(() => decodeOld({ sessions: [moving] })).toThrow();
  });
});

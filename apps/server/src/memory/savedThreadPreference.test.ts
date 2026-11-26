import { assert, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import { makeSavedPreferenceReader } from "./savedThreadPreference.ts";
import type { MemoryService } from "./MemoryService.ts";

const environmentId = M.EnvironmentId.make("env-1");
const threadId = M.ThreadId.make("thread-1");
const memorySpaceId = M.MemorySpaceId.make("00000000-0000-4000-8000-000000000001");
const item = {
  status: "active",
  pendingSync: false,
  marks: {},
  localAvailability: { exposure: "visible" },
  scope: { kind: "user" },
  revision: { provenance: { sourceThread: { environmentId, threadId } } },
};

it.effect("shows no saved preference while conversation memory is paused, even mid-read", () =>
  Effect.gen(function* () {
    let enabled = true;
    let reads = 0;
    let pauseDuringRead = false;
    const read = (() =>
      Effect.sync(() => {
        reads += 1;
        if (pauseDuringRead) enabled = false;
        return item;
      })) as unknown as MemoryService["Service"]["read"];
    const reader = makeSavedPreferenceReader(
      environmentId,
      (text) => "00000000-0000-4000-8000-" + text.length.toString().padStart(12, "0"),
      read,
      Effect.sync(() => enabled),
    );
    const ask = reader({ memorySpaceId, threadId }, Effect.void as never);
    assert.isNotNull(yield* ask);
    enabled = false;
    assert.isNull(yield* ask);
    assert.equal(reads, 1);
    enabled = true;
    pauseDuringRead = true;
    assert.isNull(yield* ask);
  }),
);

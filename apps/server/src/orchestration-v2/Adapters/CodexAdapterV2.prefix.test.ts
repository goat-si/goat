import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@goat/contracts";
import * as Effect from "effect/Effect";

import { framePendingReports } from "../../remoteReports/reportFrame.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";

describe("CodexAdapterV2 injected prefix", () => {
  it.effect("stays byte-identical across turns that carry different notices", () =>
    Effect.gen(function* () {
      // Provider prompt caches key on this prefix; a notice that leaks into it breaks every cache.
      const turn = (text: string) =>
        CodexAdapterV2.buildCodexTurnStartParams({
          nativeThreadId: "native-stable-prefix",
          codexInput: [{ type: "text", text }],
          runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          hasGoatMcp: true,
          browserToolsAvailable: true,
          deviceToolsAvailable: true,
        });
      const first = yield* turn(
        `${framePendingReports(["Report from a thread on host-a [c-1]: progress\n> tests running"])}\n\nContinue.`,
      );
      const second = yield* turn(
        'Launched thread "lane-7" (threadId t-7, host host-b) finished run r-2 with status completed.',
      );
      const { input: _first, ...firstPrefix } = first;
      const { input: _second, ...secondPrefix } = second;
      assert.notDeepEqual(first.input, second.input);
      assert.equal(JSON.stringify(firstPrefix), JSON.stringify(secondPrefix));
    }),
  );
});

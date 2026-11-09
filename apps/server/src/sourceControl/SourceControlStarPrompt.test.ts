import { SourceControlProviderKind, SourceControlStarredInput } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as SourceControlBuiltInDrivers from "./builtInDrivers.ts";
import * as SourceControlStarPrompt from "./SourceControlStarPrompt.ts";

const decodeInput = Schema.decodeUnknownSync(SourceControlStarredInput);

it.effect("pins the repository even when the RPC input contains a different repository", () => {
  const calls: Array<[string, string]> = [];
  const entries = [
    {
      driver: { kind: SourceControlProviderKind.make("github") },
      instance: {
        starRepository: (host: string, repository: string) => {
          calls.push([host, repository]);
          return Effect.succeed(true);
        },
      },
    },
  ] as unknown as ReadonlyArray<SourceControlBuiltInDrivers.SourceControlDriverEntry>;
  const input = decodeInput({
    provider: "github",
    host: "github.com",
    repository: "attacker/repo",
  });
  return Effect.gen(function* () {
    const service = yield* SourceControlStarPrompt.make;
    assert.isTrue(yield* service.star(input));
    assert.deepStrictEqual(calls, [["github.com", "goat-si/goat"]]);
  }).pipe(Effect.provideService(SourceControlBuiltInDrivers.SourceControlDrivers, entries));
});

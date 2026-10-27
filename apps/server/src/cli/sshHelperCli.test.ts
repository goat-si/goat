import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as NetService from "@goat/shared/Net";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import { runCliWithArgs } from "../binCli.ts";
import { runSshHelperCliWithArgs } from "./sshHelperCli.ts";

// SSH probe scripts compare these answers byte for byte, so the early dispatch must not change them.
it.effect("answers the SSH probe's questions exactly as the full CLI", () =>
  Effect.gen(function* () {
    const console = yield* Console.Console;
    const answer = <E, R>(
      run: (args: ReadonlyArray<string>) => Effect.Effect<void, E, R>,
      args: ReadonlyArray<string>,
    ) =>
      Effect.gen(function* () {
        const output: Array<string> = [];
        const log = (...values: ReadonlyArray<unknown>) => void output.push(values.join(" "));
        using _stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
          output.push(String(chunk));
          return true;
        });
        yield* run(args).pipe(Effect.provideService(Console.Console, { ...console, log }));
        return output;
      });
    for (const args of [["--version"], ["__ssh-helper", "protocol", "--shell"]]) {
      const fast = yield* answer(runSshHelperCliWithArgs, args);
      expect(fast.length).toBeGreaterThan(0);
      expect(fast).toEqual(yield* answer((all) => runCliWithArgs(all), args));
    }
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, NetService.layer))),
);

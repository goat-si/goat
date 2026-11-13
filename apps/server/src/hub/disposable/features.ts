import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { HubOcx } from "../HubOcx.ts";
import { CONTRACTS_ARGS, probeContracts } from "../ocxContracts.ts";

/** What the Home's OpenCodex must declare before GOAT mints (design section 5, O1, O5, O6). */
export const HOME_ATTACH_CONTRACTS = [
  "link.route/1",
  "link.operation/1",
  "link.recover/1",
] as const;

/** The Home's declared contracts; undefined when ocx cannot be asked. */
export class HomeContracts extends Context.Service<
  HomeContracts,
  { readonly contracts: Effect.Effect<ReadonlySet<string> | undefined> }
>()("goat/hub/disposable/features/HomeContracts") {}

export const homeContractsLayer = Layer.effect(
  HomeContracts,
  Effect.gen(function* () {
    const ocx = yield* HubOcx;
    return HomeContracts.of({
      contracts: ocx.home(CONTRACTS_ARGS, 30_000).pipe(
        Effect.map((output) => {
          const probed = probeContracts(output);
          return probed.kind === "known" ? probed.contracts : undefined;
        }),
        Effect.orElseSucceed(() => undefined),
      ),
    });
  }),
);

/** Whether every required feature is declared; an unreadable list declares nothing. */
export const declares = (
  declared: ReadonlySet<string> | undefined,
  required: ReadonlyArray<string>,
) => declared !== undefined && required.every((feature) => declared.has(feature));

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { ScreenRunError } from "@goat/contracts";
import type { PrimitiveChannelRequest } from "../cua/ComputerUsePrimitiveChannel.ts";
import type { Request } from "./BrowserOriginGrants.ts";

type BindRequest = Request & { readonly claimId: string; readonly bindingVersion: number };
interface BindReply {
  readonly status: string;
  readonly result?: unknown;
  readonly driverGeneration?: number;
}
type Transport = {
  readonly request: (input: PrimitiveChannelRequest) => Effect.Effect<BindReply, ScreenRunError>;
};

export class BrowserClaimBindFailure extends Schema.TaggedError<BrowserClaimBindFailure>()(
  "BrowserClaimBindFailure",
  { cause: Schema.Defect() },
) {}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const makeBrowserClaimBind = Effect.fn("BrowserClaimBind.make")((channel: Transport) =>
  Effect.succeed(
    Effect.fn("BrowserClaimBind.bind")(function* (input: BindRequest) {
      const now = yield* Clock.currentTimeMillis;
      const reply = yield* channel
        .request({
          threadId: input.threadId,
          runId: `claim-bind:${input.claimId}`,
          turnId: `claim-bind:${input.claimId}`,
          callId: 0,
          deadlineMillis: now + 35_000,
          tool: "get_browser_state",
          authority: "claimBind",
          bindingVersion: input.bindingVersion,
          args: {
            pid: input.pid,
            window_id: input.windowId,
            origin_scope: [input.origin],
            session: `goat-claim:${input.claimId}`,
          },
        })
        .pipe(Effect.mapError((cause) => new BrowserClaimBindFailure({ cause })));
      const result =
        record(reply.result) && record(reply.result.structuredContent)
          ? reply.result.structuredContent
          : undefined;
      if (
        reply.status !== "settled" ||
        !record(reply.result) ||
        reply.result.isError === true ||
        !result ||
        result.mode !== "bind" ||
        !Array.isArray(result.tabs)
      )
        return yield* new BrowserClaimBindFailure({
          cause: "Browser bind returned no tab listing.",
        });
      const active = result.tabs.filter((tab: unknown) => record(tab) && tab.active === true);
      if (
        active.length !== 1 ||
        !record(active[0]) ||
        typeof active[0].tab_id !== "string" ||
        typeof active[0].title !== "string" ||
        typeof active[0].url !== "string" ||
        typeof reply.driverGeneration !== "number" ||
        reply.driverGeneration < 1
      )
        return yield* new BrowserClaimBindFailure({
          cause: "The active tab is not available in the granted origin.",
        });
      return {
        tabId: active[0].tab_id,
        title: active[0].title,
        url: active[0].url,
        driverGeneration: reply.driverGeneration,
      };
    }),
  ),
);

export class BrowserClaimBind extends Context.Service<
  BrowserClaimBind,
  {
    readonly bind: (request: BindRequest) => Effect.Effect<
      {
        readonly tabId: string;
        readonly title: string;
        readonly url: string;
        readonly driverGeneration: number;
      },
      Error
    >;
    readonly install?: (
      bind: (request: BindRequest) => Effect.Effect<
        {
          readonly tabId: string;
          readonly title: string;
          readonly url: string;
          readonly driverGeneration: number;
        },
        Error
      >,
    ) => Effect.Effect<void>;
  }
>()("goat/preview/BrowserClaimBind") {}

export const layer = Layer.effect(
  BrowserClaimBind,
  Effect.sync(() => {
    let active: BrowserClaimBind["Service"]["bind"] | undefined;
    return {
      bind: Effect.fn("BrowserClaimBind.dispatch")((request: BindRequest) =>
        Effect.suspend(() =>
          active
            ? active(request)
            : Effect.fail(
                new BrowserClaimBindFailure({ cause: "Browser bind channel is unavailable." }),
              ),
        ),
      ),
      install: (bind) =>
        Effect.sync(() => {
          active = bind;
        }),
    };
  }),
);

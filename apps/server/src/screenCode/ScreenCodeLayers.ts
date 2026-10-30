import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as BrowserClaimBind from "../preview/BrowserClaimBind.ts";

import * as ComputerUsePrimitiveChannel from "../cua/ComputerUsePrimitiveChannel.ts";
import * as ScreenCursorPublisher from "../cua/ScreenCursorPublisher.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as ScreenRunService from "./ScreenRunService.ts";
import * as ScreenRunTurnEnd from "./ScreenRunTurnEnd.ts";

/** Screen runs over the server browser, which keeps its preview browser visible to the routes. */
export const withScreenCode = <A, E, R>(serverBrowser: Layer.Layer<A, E, R>) =>
  ScreenRunTurnEnd.layer.pipe(
    Layer.provideMerge(ScreenRunService.layerWithTabHost()),
    Layer.provideMerge(
      ScreenCursorPublisher.layer.pipe(
        Layer.provideMerge(serverBrowser.pipe(Layer.provideMerge(PreviewBrowser.layer))),
      ),
    ),
  );

const primitives = ComputerUsePrimitiveChannel.layer;
const bindInstaller = Layer.effectDiscard(
  Effect.gen(function* () {
    const channel = yield* ComputerUsePrimitiveChannel.ComputerUsePrimitiveChannel;
    const service = yield* BrowserClaimBind.BrowserClaimBind;
    const bind = yield* BrowserClaimBind.makeBrowserClaimBind(channel);
    if (service.install) yield* service.install(bind);
  }),
).pipe(Layer.provide(primitives), Layer.provide(BrowserClaimBind.layer));

export const provideScreenPrimitives = <A, E, R>(application: Layer.Layer<A, E, R>) =>
  application.pipe(Layer.provideMerge(Layer.merge(primitives, bindInstaller)));

export const provideScreenPrimitivesAfter =
  <I, IE, IR>(infrastructure: Layer.Layer<I, IE, IR>) =>
  <A, E, R>(application: Layer.Layer<A, E, R>) =>
    application.pipe(Layer.provideMerge(infrastructure), provideScreenPrimitives);

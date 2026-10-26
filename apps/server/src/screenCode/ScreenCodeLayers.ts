import * as Layer from "effect/Layer";

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

export const primitives = ComputerUsePrimitiveChannel.layer;

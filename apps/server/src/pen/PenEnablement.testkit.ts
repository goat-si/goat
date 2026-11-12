import * as Layer from "effect/Layer";

import { PenEnablement } from "./PenEnablement.ts";

/** Opens the Pen target for a test; production wiring only ever provides PenEnablement.layer. */
export const layerTest = (enabled: boolean) => Layer.succeed(PenEnablement, { enabled });

import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

/**
 * Closed in this build, whatever the pen setting holds; no setting, variable or flag opens it.
 * It opens only at the mesh link integrated review (design D8 step 6), once thread origin, L3c's
 * dispatch upload and L5's confirmation exist; the pull request lists the conditions.
 */
export const PEN_TARGET_ENABLED = false;

export class PenEnablement extends Context.Service<PenEnablement, { readonly enabled: boolean }>()(
  "goat/pen/PenEnablement",
) {}

export const layer = Layer.succeed(PenEnablement, { enabled: PEN_TARGET_ENABLED });

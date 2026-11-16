import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";

// Effect 4.1 moved SecureRandom and Digest out of NodeServices. Files at their code budget take
// the pair from here so the extra provider does not grow them; see docs/operations/code-quality.md.
export const layer = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);

// Writes vectors/identity.json and vectors/relay.json. Run once; tests recompute and compare.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { buildIdentityVector, buildRelayVector } from "../src/vectors.ts";

const dir = NodePath.join(import.meta.dirname, "..", "vectors");
NodeFS.mkdirSync(dir, { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(dir, "identity.json"),
  JSON.stringify(await buildIdentityVector(), null, 2) + "\n",
);
NodeFS.writeFileSync(
  NodePath.join(dir, "relay.json"),
  JSON.stringify(await buildRelayVector(), null, 2) + "\n",
);

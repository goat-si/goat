// Writes vectors/identity.json, vectors/relay.json and vectors/login.json. Tests recompute and compare.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { buildLoginVector } from "../src/loginVectors.ts";
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
NodeFS.writeFileSync(
  NodePath.join(dir, "login.json"),
  JSON.stringify(await buildLoginVector(), null, 2) + "\n",
);

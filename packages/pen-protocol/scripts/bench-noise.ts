// S6 harness on Node: prints handshake time and record throughput as one JSON line.
// @effect-diagnostics nodeBuiltinImport:off - A script: Node's CSPRNG feeds the bench.
import * as NodeCrypto from "node:crypto";
import { runBench } from "./noiseBench.ts";

const result = runBench(
  () => performance.now(),
  (n) => new Uint8Array(NodeCrypto.randomBytes(n)),
);
process.stdout.write(JSON.stringify({ runtime: "node " + process.version, ...result }) + "\n");

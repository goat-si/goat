// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export type WorkerOrder = "parallel" | "dependent";

export function parseWorkerOrder(value: string | undefined): WorkerOrder {
  if (value === "parallel" || value === "dependent") return value;
  throw new Error("Choose parallel or dependent.");
}

export function workerOrderPrompt(order: WorkerOrder, workspace: string) {
  const directory = JSON.stringify(NodePath.resolve(workspace));
  const instructions =
    order === "parallel"
      ? "A and B are independent. Start both workers in parallel so their probes overlap. A runs node probe.mjs a.txt and B runs node probe.mjs b.txt."
      : "First have worker A run node probe.mjs a.txt. Wait until A has finished successfully and delivered its value. Only then start worker B. Include A's actual value in B's assignment: B runs node probe.mjs b-<A's value>.txt with that value substituted.";
  return [
    "Use exactly two local delegated workers in the project directory " + directory + ".",
    instructions,
    "Each worker must run its own probe in that directory, wait for it to finish, and return the value printed in its output.",
    "Coordinate the workers yourself without reading the files or running their probes in the parent. Reply with both delivered values.",
  ].join(" ");
}

// Each process measures its own work interval on the same local host. Launching two queued tasks
// or keeping an idle worker thread open does not make their probes overlap.
const probe = `import { readFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
const file = process.argv[2];
if (!/^(a|b|b-[a-f0-9-]{36})\\.txt$/.test(file)) throw new Error("Unknown probe input");
const started = Date.now();
const value = readFileSync(new URL(file, import.meta.url), "utf8").trim();
await setTimeout(12_000);
console.log("WORKER_ORDER", file, started, Date.now(), value);
`;

export function prepareWorkerOrder(order: WorkerOrder, workspace: string) {
  const a = NodeCrypto.randomUUID();
  NodeFS.mkdirSync(workspace);
  NodeFS.writeFileSync(NodePath.join(workspace, "a.txt"), a + "\n");
  NodeFS.writeFileSync(
    NodePath.join(workspace, order === "parallel" ? "b.txt" : "b-" + a + ".txt"),
    NodeCrypto.randomUUID() + "\n",
  );
  NodeFS.writeFileSync(NodePath.join(workspace, "probe.mjs"), probe);
  return workerOrderPrompt(order, workspace);
}

export function readWorkerOrder(order: WorkerOrder, workspace: string) {
  const read = (name: string) => {
    const value = NodeFS.readFileSync(NodePath.join(workspace, name), "utf8").trim();
    if (!/^[a-f0-9-]{36}$/.test(value)) throw new Error("Unexpected worker-order fixture value");
    return { file: name, value };
  };
  const a = read("a.txt");
  return { a, b: read(order === "parallel" ? "b.txt" : "b-" + a.value + ".txt") };
}

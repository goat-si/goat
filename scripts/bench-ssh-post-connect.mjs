// Run against this worktree's isolated dev server. Keep credentials in files, never CLI args.
// node scripts/bench-ssh-post-connect.mjs --upstream http://127.0.0.1:PORT --dev-log /tmp/dev.log \
//   --bearer-file /tmp/ssh-bench-bearer --delay-ms 200 --runs 5 [--ref BASE_COMMIT]
import * as NodeNet from "node:net";
import * as NodeStream from "node:stream";
import * as NodeFSP from "node:fs/promises";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodePath from "node:path";
import { createServer } from "vite-plus";

const { values } = NodeUtil.parseArgs({
  options: {
    upstream: { type: "string" },
    "dev-log": { type: "string" },
    "bearer-file": { type: "string" },
    ref: { type: "string" },
    "delay-ms": { type: "string", default: "200" },
    runs: { type: "string", default: "5" },
  },
});
const upstream = new URL(values.upstream ?? "http://127.0.0.1:3773");
if (
  upstream.protocol !== "http:" ||
  !["127.0.0.1", "localhost", "[::1]"].includes(upstream.hostname)
) {
  throw new Error("Use a loopback HTTP dev server with isolated state.");
}
if (!values["bearer-file"]) throw new Error("--bearer-file is required");
const delayMs = Number(values["delay-ms"]),
  runs = Number(values.runs);
if (!Number.isFinite(delayMs) || delayMs < 0 || !Number.isInteger(runs) || runs < 5) {
  throw new Error("Use a nonnegative delay and at least five runs.");
}
const root = NodePath.resolve(import.meta.dirname, "..");
const pipelineModule = "/apps/web/src/connection/bench-ssh-post-connect.pipeline.ts";
const sockets = new Set();
const delay = () =>
  new NodeStream.Transform({
    transform(chunk, encoding, done) {
      // This is deliberately injected network latency, never a test synchronization wait.
      setTimeout(() => done(null, chunk), delayMs);
    },
  });
const relay = NodeNet.createServer((client) => {
  const remote = NodeNet.connect(Number(upstream.port || 80), upstream.hostname);
  for (const socket of [client, remote]) {
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {
      client.destroy();
      remote.destroy();
    });
  }
  client.pipe(delay()).pipe(remote);
  remote.pipe(delay()).pipe(client);
});
let vite;
try {
  await new Promise((done, reject) => {
    relay.once("error", reject);
    relay.listen(0, "127.0.0.1", done);
  });
  const sourceFiles = values.ref
    ? new Set(
        NodeChildProcess.execFileSync(
          "git",
          ["diff", "--name-only", values.ref, "--", "apps/web/src", "packages/client-runtime/src"],
          { cwd: root, encoding: "utf8" },
        )
          .trim()
          .split("\n"),
      )
    : new Set();
  // Compare application code from the ref while keeping the current benchmark driver.
  sourceFiles.delete(pipelineModule.slice(1));
  vite = await createServer({
    root,
    configFile: false,
    server: { middlewareMode: true, watch: null },
    resolve: { alias: { "~": NodePath.resolve(root, "apps/web/src") } },
    ssr: { noExternal: [/^@goat\//] },
    plugins: values.ref
      ? [
          {
            name: "benchmark-baseline",
            enforce: "pre",
            load(id) {
              const path = NodePath.relative(root, id.split("?")[0]);
              if (sourceFiles.has(path))
                return NodeChildProcess.execFileSync("git", ["show", `${values.ref}:${path}`], {
                  cwd: root,
                  encoding: "utf8",
                });
            },
          },
        ]
      : [],
  });
  const { run } = await vite.ssrLoadModule(pipelineModule);
  const devLog = values["dev-log"] ? await NodeFSP.readFile(values["dev-log"], "utf8") : "";
  const pairingUrl = devLog.match(/pairingUrl:\s*(https?:\/\/\S+)/)?.[1];
  const pairingCredential = pairingUrl
    ? new URLSearchParams(new URL(pairingUrl).hash.slice(1)).get("token")
    : undefined;
  const report = await run({
    upstream: upstream.origin,
    httpBaseUrl: `http://127.0.0.1:${relay.address().port}`,
    bearerFile: NodePath.resolve(values["bearer-file"]),
    pairingCredential,
    runs,
  });
  console.log(
    JSON.stringify({ ref: values.ref ?? "working-tree", delayMs, runs, ...report }, null, 2),
  );
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise((done) => relay.close(done));
  await vite?.close();
}

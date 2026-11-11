// Bundles every exported client module (and the S6 bench) for a neutral platform and compiles the bundle with the
// hermesc that React Native's hermes-compiler ships. Proves the client parses and compiles for that Hermes; device
// speed (S6) and runtime behaviour (S9) are measured on phones by Q-M with the bench bundle written here.
// @effect-diagnostics nodeBuiltinImport:off - A build script: it reads package.json and runs hermesc.
// oxlint-disable goat/no-global-process-runtime -- A standalone build script with no Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { build } from "vite-plus";

const packageDir = NodePath.join(import.meta.dirname, "..");
const exportsMap = JSON.parse(
  NodeFS.readFileSync(NodePath.join(packageDir, "package.json"), "utf8"),
).exports as Record<string, string>;
const clientModules = Object.entries(exportsMap)
  .filter(([subpath]) => subpath.startsWith("./client/"))
  .map(([, file]) => NodePath.join(packageDir, file));
const entries = {
  client: clientModules
    .map((file, i) => "export * as m" + i + " from " + JSON.stringify(file) + ";")
    .join("\n"),
  bench:
    "import { runBench } from " +
    JSON.stringify(NodePath.join(packageDir, "scripts/noiseBench.ts")) +
    ";\nexport { runBench };",
};

const outDir = process.argv[2] ?? NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pen-hermes-"));
const builtins = new Set(NodeModule.builtinModules);

for (const [name, source] of Object.entries(entries)) {
  const entry = NodePath.join(outDir, name + ".entry.ts");
  NodeFS.writeFileSync(entry, source + "\n");
  await build({
    configFile: false,
    logLevel: "warn",
    plugins: [
      {
        name: "pen-hermes-no-node-builtins",
        enforce: "pre",
        resolveId(id) {
          const bare = id.startsWith("node:") ? id.slice(5) : id;
          if (builtins.has(bare)) throw new Error("client code imports a Node built-in: " + id);
          return null;
        },
      },
    ],
    build: {
      outDir,
      emptyOutDir: false,
      minify: false,
      target: "es2019",
      lib: { entry, name: "PenClient_" + name, formats: ["iife"], fileName: () => name + ".js" },
    },
  });
}

const require = NodeModule.createRequire(import.meta.url);
// hermes-compiler is React Native's dependency, so resolve it from the react-native that apps/mobile uses.
const reactNativeDir = NodePath.dirname(
  require.resolve("react-native/package.json", {
    paths: [NodePath.join(packageDir, "../../apps/mobile")],
  }),
);
const compilerDir = NodePath.dirname(
  require.resolve("hermes-compiler/package.json", {
    paths: [reactNativeDir],
  }),
);
const platformDir =
  NodeOS.platform() === "darwin"
    ? "osx-bin"
    : NodeOS.platform() === "win32"
      ? "win64-bin"
      : "linux64-bin";
const hermesc = NodePath.join(compilerDir, "hermesc", platformDir, "hermesc");
const version = JSON.parse(
  NodeFS.readFileSync(NodePath.join(compilerDir, "package.json"), "utf8"),
).version;
for (const name of Object.keys(entries)) {
  const input = NodePath.join(outDir, name + ".js");
  const result = NodeChildProcess.spawnSync(
    hermesc,
    ["-emit-binary", "-out", input + ".hbc", input],
    {
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stdout + result.stderr);
    throw new Error("hermesc " + version + " failed on " + name + ".js");
  }
  process.stdout.write(
    "hermesc " +
      version +
      " compiled " +
      name +
      ".js (" +
      NodeFS.statSync(input).size +
      " bytes) to " +
      input +
      ".hbc\n",
  );
}

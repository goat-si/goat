import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const helperSource = NodeURL.fileURLToPath(
  new URL("../native/computer-use-helper/", import.meta.url),
);

/**
 * Builds the production helper into an ad-hoc signed development bundle under directory, with
 * the transport-only fixture driver (fixtures/mcp-echo.c) as its Cua Driver.
 */
export function buildHelperFixture(directory, options = {}) {
  const bundle = NodePath.join(directory, "GOAT Relay Fixture.app");
  const executable = NodePath.join(bundle, "Contents/MacOS/GOAT Relay Fixture");
  const resources = NodePath.join(bundle, "Contents/Resources/cua-driver");
  NodeFS.mkdirSync(NodePath.dirname(executable), { recursive: true });
  NodeFS.mkdirSync(resources, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(bundle, "Contents/Info.plist"),
    '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>si.goat.relay.fixture.computer-use</string><key>CFBundleExecutable</key><string>GOAT Relay Fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/><key>GOATComputerUseAllowAnyParent</key><true/></dict></plist>',
  );
  const swift = NodeFS.readdirSync(helperSource)
    .filter((name) => name.endsWith(".swift"))
    .map((name) => NodePath.join(helperSource, name));
  NodeChildProcess.execFileSync("xcrun", [
    "swiftc",
    ...(options.optimize === false ? [] : ["-whole-module-optimization"]),
    "-lbsm",
    "-o",
    executable,
    ...swift,
  ]);
  const driver = NodePath.join(resources, "cua-driver");
  NodeChildProcess.execFileSync("cc", [
    NodePath.join(helperSource, "fixtures/mcp-echo.c"),
    "-o",
    driver,
  ]);
  NodeChildProcess.execFileSync("codesign", ["--force", "--sign", "-", driver]);
  NodeChildProcess.execFileSync("codesign", ["--force", "--sign", "-", bundle]);
  return { bundle, executable };
}

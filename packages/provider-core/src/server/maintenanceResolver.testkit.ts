// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export function writeExecutable(path: string) {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, "#!/bin/sh\n");
  NodeFS.chmodSync(path, 0o755);
}

export function linkIntoPackage(
  tempDir: string,
  name: string,
  packageSegments: ReadonlyArray<string>,
) {
  const target = NodePath.join(tempDir, ...packageSegments, "bin", `${name}.js`);
  writeExecutable(target);
  const link = NodePath.join(tempDir, "bin", name);
  NodeFS.mkdirSync(NodePath.dirname(link), { recursive: true });
  NodeFS.symlinkSync(target, link);
  return link;
}

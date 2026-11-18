// @effect-diagnostics nodeBuiltinImport:off - the standalone launcher uses Node directly.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import {
  parseLegacyServiceState,
  parseServiceState,
  SERVICE_ENV_FILE,
  SERVICE_LAUNCHER_CONTEXT_ENV,
  type ServiceState,
} from "./cloud/serviceProtocol.ts";
import { replaceFileDurably } from "./serviceUnitRepoint.ts";

const MANAGED_SERVICE_ENV_NAMES = new Set([
  "PATH",
  "GOAT_HOME",
  "GOAT_BOOT_SERVICE_UNIT",
  SERVICE_LAUNCHER_CONTEXT_ENV,
]);

export async function readServiceEnvironment(
  baseDir: string,
  inherited: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  const environment = { ...inherited };
  let contents: string;
  try {
    contents = await NodeFSP.readFile(NodePath.join(baseDir, SERVICE_ENV_FILE), "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return environment;
    throw cause;
  }
  for (const [name, value] of Object.entries(NodeUtil.parseEnv(contents))) {
    if (
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
      !MANAGED_SERVICE_ENV_NAMES.has(name.toUpperCase())
    ) {
      environment[name] = value;
    }
  }
  return environment;
}

export async function readServiceState(filePath: string): Promise<ServiceState> {
  const contents = await NodeFSP.readFile(filePath, "utf8");
  const state = parseServiceState(contents) ?? parseLegacyServiceState(contents);
  if (state === undefined) throw new Error("Service state is invalid or unsupported.");
  return state;
}

export async function writeServiceState(filePath: string, state: ServiceState): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(filePath), { recursive: true, mode: 0o700 });
  await replaceFileDurably(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

export const sameSelection = (left: ServiceState, right: ServiceState) =>
  left.activeVersion === right.activeVersion &&
  left.update?.id === right.update?.id &&
  left.update?.status === right.update?.status;

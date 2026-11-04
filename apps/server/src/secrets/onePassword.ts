// @effect-diagnostics nodeBuiltinImport:off - This boundary guards the child and bounds its output.
import * as NodeChildProcess from "node:child_process";
import { guardChild } from "@goat/shared/errorGuards";
import { isOnePasswordReference } from "@goat/contracts";

const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const TIMEOUT_MS = 45_000;

type Run = (command: string, args: ReadonlyArray<string>) => Promise<string>;

export function runBounded(command: string, args: ReadonlyArray<string>): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let bytes = 0;
    const chunks: Buffer[] = [];
    let child: NodeChildProcess.ChildProcess;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(new Error("Secret provider process failed"));
    };
    // @effect-diagnostics-next-line globalTimers:off -- The process watchdog is cleared on settlement.
    const timer = setTimeout(fail, TIMEOUT_MS);
    try {
      child = guardChild(
        NodeChildProcess.spawn(command, [...args], { stdio: ["ignore", "pipe", "ignore"] }),
        fail,
      );
    } catch {
      clearTimeout(timer);
      reject(new Error("Secret provider process failed"));
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) return fail();
      chunks.push(chunk);
    });
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) return fail();
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

export async function readOnePassword(
  account: string,
  reference: string,
  run: Run = runBounded,
): Promise<string> {
  if (account.length > 253 || !ACCOUNT.test(account) || !isOnePasswordReference(reference)) {
    throw new Error("Invalid 1Password account or secret reference");
  }
  try {
    const value = await run("op", [
      "--cache=false",
      "read",
      `--account=${account}`,
      "--no-newline",
      reference,
    ]);
    if (value.trim().length === 0) throw new Error("Empty secret");
    return value;
  } catch {
    throw new Error("Could not read secret from 1Password");
  }
}

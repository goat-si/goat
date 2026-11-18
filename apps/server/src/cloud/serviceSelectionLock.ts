// @effect-diagnostics nodeBuiltinImport:off -- Shared with the standalone launcher, which has no Effect runtime.
// @effect-diagnostics globalTimers:off -- Bounded cross-process lease acquisition in the standalone launcher.
// @effect-diagnostics globalDate:off -- The standalone launcher has no Effect clock for its acquisition deadline.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { legacyOwnerStartTimeCommand } from "../legacyServerOwner.ts";

// Coarse boot time: a lease from an earlier boot is dead even when its PID is live again.
const bootEpochSeconds = () => Math.round(Date.now() / 1000 - NodeOS.uptime());

function processStartIdentity(pid: number): Promise<string | undefined> {
  // oxlint-disable-next-line goat/no-global-process-runtime -- Standalone launcher has no Effect runtime.
  const platform = NodeOS.platform();
  if (platform === "linux") {
    try {
      const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
      // Field 22 is the start tick; the parenthesized command may contain spaces and parentheses.
      const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      return Promise.resolve(start !== undefined && /^\d+$/.test(start) ? start : undefined);
    } catch {
      return Promise.resolve(undefined);
    }
  }
  const { command, args, env } = legacyOwnerStartTimeCommand(pid, platform);
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      command,
      args,
      { env: { ...process.env, ...env }, timeout: 2_000, maxBuffer: 16_384 },
      (error, stdout) => {
        const start = stdout.trim();
        resolve(
          error === null && start !== "" ? Buffer.from(start).toString("base64url") : undefined,
        );
      },
    );
  });
}

let ownStartIdentity: Promise<string | undefined> | undefined;

/** Serialize durable selection and unit writes, never manager stop/start commands. */
export async function acquireServiceSelectionLock(selectionPath: string): Promise<() => void> {
  const directory = NodePath.dirname(selectionPath);
  NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = selectionPath + ".selection-lock";
  const identity = await (ownStartIdentity ??= processStartIdentity(process.pid));
  const owner = `${process.pid}.${bootEpochSeconds()}.${NodeCrypto.randomUUID()}${identity === undefined ? "" : `.${identity}`}`;
  const candidate = `${lock}.${owner}`;
  const deadline = Date.now() + 30_000;
  const removeEmptyLock = () => {
    try {
      NodeFS.rmdirSync(lock);
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw error;
    }
  };
  NodeFS.mkdirSync(candidate, { mode: 0o700 });
  try {
    NodeFS.writeFileSync(NodePath.join(candidate, owner), "", { mode: 0o600 });
    while (true) {
      try {
        // Publish the owner atomically; rename cannot replace another populated directory.
        NodeFS.renameSync(candidate, lock);
        return () => {
          NodeFS.unlinkSync(NodePath.join(lock, owner));
          removeEmptyLock();
        };
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))
          throw error;
      }
      let owners: string[];
      try {
        owners = NodeFS.readdirSync(lock);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const [previous] = owners;
      if (owners.length === 1 && previous !== undefined) {
        const [pidText, bootText, , previousIdentity] = previous.split(".");
        const pid = Number(pidText);
        if (!Number.isSafeInteger(pid) || pid <= 0)
          throw new Error(`Invalid service selection lock owner at ${lock}.`);
        const ownerBoot = Number(bootText);
        const fromEarlierBoot =
          Number.isSafeInteger(ownerBoot) && Math.abs(ownerBoot - bootEpochSeconds()) > 60;
        let dead = fromEarlierBoot;
        if (!dead) {
          try {
            process.kill(pid, 0);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "ESRCH" && code !== "EPERM") throw error;
            dead = code === "ESRCH";
          }
        }
        if (!dead && previousIdentity) {
          const currentIdentity = pid === process.pid ? identity : await processStartIdentity(pid);
          dead = currentIdentity !== undefined && currentIdentity !== previousIdentity;
        }
        if (dead) {
          // Remove only this dead owner's unique file, never a replacement owner's.
          try {
            NodeFS.unlinkSync(NodePath.join(lock, previous));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
      }
      removeEmptyLock();
      if (Date.now() >= deadline)
        throw new Error(
          `Service selection is locked at ${lock}. Retry when the other operation finishes.`,
        );
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    NodeFS.rmSync(candidate, { recursive: true, force: true });
  }
}

// Supervises the goat2-host process for the Electron shell. No Electron imports here so the
// policy runs under plain `node --test` with fake hosts.
//
// - The host runs as its own process group (detached), so the agents it starts are in that group
//   or below it and one signal to -pgid reaches the whole tree the host owns.
// - Quitting ends the work (structure/10_processes.md): stop() sends SIGTERM to the group, then
//   SIGKILL to whatever is left after the grace period.
// - A host that exits on its own is a crash: its leftover group is killed, then it is restarted
//   under GOAT v1's recovery policy, lifted verbatim in ./backend/DesktopBackendRecoveryPolicy.ts
//   (jittered 1 s .. 30 s, at most 5 restarts per 10 minutes, then a crash-loop pause; delay index
//   record.attempt - 1 as v1 DesktopBackendManager.ts:722).
//   Exception: a host that exits with code 0 before it ever got ready chose to exit (an empty stub
//   binary does this); restarting it cannot help, so it is left "exited" until Start Host.
// - stdin stays an open pipe the shell never writes. If the shell dies without running stop(),
//   the host sees EOF and exits (host-side rule, lane E).
import { spawn, type ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";
import {
  emptyRecoveryRecord,
  recordRestart,
  restartDelayMs,
  type RecoveryRecord,
} from "./backend/DesktopBackendRecoveryPolicy.ts";

export type HostPhase = "starting" | "ready" | "restarting" | "crash-loop" | "exited" | "stopping" | "stopped";

export interface HostState {
  readonly phase: HostPhase;
  readonly pid: number | null;
  /** Restarts counted inside the current recovery window. */
  readonly restarts: number;
  /** "code=1", "signal=SIGSEGV", "spawn error: ENOENT", ... */
  readonly lastExit: string | null;
  /** The host's start line for the current process, once printed. */
  readonly announce: HostAnnounce | null;
}

/** First JSON line the host prints on stdout (owner contract 2026-11-28). */
export interface HostAnnounce {
  readonly wsUrl: string;
  readonly mcpUrl: string | null;
  readonly port: number | null;
  readonly generation: number | string | null;
}

/** Parses one stdout line; null when it is not the start line. */
export function parseAnnounce(line: string): HostAnnounce | null {
  const text = line.trim();
  if (!text.startsWith("{")) return null;
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (typeof value.wsUrl !== "string") return null;
    return {
      wsUrl: value.wsUrl,
      mcpUrl: typeof value.mcpUrl === "string" ? value.mcpUrl : null,
      port: typeof value.port === "number" ? value.port : null,
      generation: typeof value.generation === "number" || typeof value.generation === "string" ? value.generation : null,
    };
  } catch {
    return null;
  }
}

export interface HostSupervisorOptions {
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd?: string;
  /**
   * /health of the host that printed this start line. Polled only after the start line, so a 200
   * always comes from the announced host (no latched answer from whatever held the port earlier).
   */
  readonly healthUrl: (announce: HostAnnounce) => string;
  /** Receives the host's stdout and stderr. */
  readonly output?: Writable;
  readonly log?: (line: string) => void;
  readonly onState?: (state: HostState) => void;
  readonly stopGraceMs?: number;
  readonly killWaitMs?: number;
  readonly healthIntervalMs?: number;
  /** Overrides v1's jittered delay (tests). */
  readonly restartDelayMs?: (attempt: number) => number;
  readonly now?: () => number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** True while any process is still in the group (ESRCH = empty). */
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // Group already empty.
  }
}

async function waitUntil(check: () => boolean, timeoutMs: number, stepMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(stepMs);
  }
  return check();
}

/** SIGTERM the group, wait up to graceMs, SIGKILL what is left. Resolves true once the group is empty. */
export async function killGroup(pgid: number, graceMs: number, killWaitMs = 2_000): Promise<boolean> {
  if (!groupAlive(pgid)) return true;
  signalGroup(pgid, "SIGTERM");
  if (await waitUntil(() => !groupAlive(pgid), graceMs)) return true;
  signalGroup(pgid, "SIGKILL");
  return waitUntil(() => !groupAlive(pgid), killWaitMs);
}

export class HostSupervisor {
  readonly #opts: HostSupervisorOptions;
  #child: ChildProcess | null = null;
  #childExited: Promise<void> = Promise.resolve();
  #restartTimer: ReturnType<typeof setTimeout> | null = null;
  #record: RecoveryRecord = emptyRecoveryRecord();
  #state: HostState = { phase: "stopped", pid: null, restarts: 0, lastExit: null, announce: null };
  #stopping = false;
  #stopPromise: Promise<void> | null = null;
  #generation = 0;

  constructor(options: HostSupervisorOptions) {
    this.#opts = options;
  }

  get state(): HostState {
    return this.#state;
  }

  /** Starts the host; also ends a crash-loop pause (the "Start Host" menu item). */
  start(): void {
    // A manual restart owns the next spawn until the old group is gone (it starts the new host).
    if (this.#restartInProgress !== null) return;
    this.#startFresh();
  }

  #startFresh(): void {
    // While a crashed host's group is still being cleaned, recovery owns the next spawn.
    if (this.#stopping || this.#child !== null || this.#recoveryActive) return;
    if (this.#restartTimer !== null) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = null;
    }
    // v1 DesktopBackendRecovery.reset: clear the budget, keep the slow-crash history.
    const { history, notifiedKey } = this.#record;
    this.#record = {
      ...emptyRecoveryRecord(),
      ...(history === undefined ? {} : { history }),
      ...(notifiedKey === undefined ? {} : { notifiedKey }),
    };
    this.#set({ restarts: 0 });
    this.#spawn();
  }

  /** Ends the host and everything in its process group. Idempotent. */
  stop(): Promise<void> {
    if (this.#stopPromise !== null) return this.#stopPromise;
    this.#stopping = true;
    if (this.#restartTimer !== null) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = null;
    }
    this.#stopPromise = (async () => {
      // A restart in progress is ending the old group; it sees #stopping and starts nothing new.
      if (this.#restartInProgress !== null) await this.#restartInProgress;
      const child = this.#child;
      if (child?.pid !== undefined) {
        this.#set({ phase: "stopping" });
        const pgid = child.pid;
        const empty = await killGroup(pgid, this.#opts.stopGraceMs ?? 5_000, this.#opts.killWaitMs);
        await this.#childExited;
        if (!empty) this.#log(`host group ${pgid} still has processes after SIGKILL`);
      }
      // A crash cleanup that was already running finishes before we report stopped.
      await this.#recovering;
      this.#set({ phase: "stopped", pid: null });
    })();
    return this.#stopPromise;
  }

  #restartInProgress: Promise<void> | null = null;

  /**
   * Ends the running host and its whole group on purpose, then starts a fresh one (menu "Restart
   * Host…", e.g. to pick up a login-shell PATH that arrived after the host started). Not a crash:
   * the old host's exit is ignored and the recovery budget is reset as by start().
   */
  restart(): Promise<void> {
    if (this.#stopping) return Promise.resolve();
    if (this.#restartInProgress !== null) return this.#restartInProgress;
    this.#restartInProgress = (async () => {
      if (this.#restartTimer !== null) {
        clearTimeout(this.#restartTimer);
        this.#restartTimer = null;
      }
      const child = this.#child;
      // A new generation first, so the old host's exit is not taken for a crash.
      this.#generation += 1;
      this.#child = null;
      this.#log("host restart requested");
      this.#set({ phase: "restarting", pid: null, announce: null });
      if (child?.pid !== undefined) {
        const empty = await killGroup(child.pid, this.#opts.stopGraceMs ?? 5_000, this.#opts.killWaitMs);
        if (!empty) this.#log(`host group ${child.pid} still has processes after SIGKILL`);
      }
      await this.#recovering;
      if (this.#stopping) return;
      this.#startFresh();
    })().finally(() => {
      this.#restartInProgress = null;
    });
    return this.#restartInProgress;
  }

  #recovering: Promise<void> = Promise.resolve();
  #recoveryActive = false;
  /** Per host process: /health answered 200, and whether "ready" (start line + 200) was reached. */
  #healthy = false;
  #reachedReady = false;

  #spawn(): void {
    const generation = ++this.#generation;
    this.#healthy = false;
    this.#reachedReady = false;
    this.#set({ phase: "starting", pid: null, announce: null });
    let child: ChildProcess;
    try {
      child = spawn(this.#opts.command, [...(this.#opts.args ?? [])], {
        cwd: this.#opts.cwd,
        env: this.#opts.env,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      this.#onExit(generation, `spawn error: ${(error as Error).message}`, null);
      return;
    }
    this.#child = child;
    let exited!: () => void;
    this.#childExited = new Promise<void>((resolve) => (exited = resolve));
    if (this.#opts.output !== undefined) {
      child.stdout?.pipe(this.#opts.output, { end: false });
      child.stderr?.pipe(this.#opts.output, { end: false });
    } else {
      child.stderr?.resume();
    }
    let pending = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      if (this.#state.announce !== null || generation !== this.#generation) return;
      pending += chunk.toString("utf8");
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        const announce = parseAnnounce(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        if (announce !== null) {
          pending = "";
          this.#log(`host announced ${announce.wsUrl}`);
          this.#set({ announce });
          void this.#waitReady(generation, announce);
          return;
        }
        newline = pending.indexOf("\n");
      }
      if (pending.length > 64 * 1024) pending = "";
    });
    // EPIPE on our end of stdin after the host exits must not crash the shell.
    child.stdin?.on("error", () => {});
    let settled = false;
    const settle = (reason: string) => {
      if (settled) return;
      settled = true;
      exited();
      this.#onExit(generation, reason, child.pid ?? null);
    };
    child.once("error", (error) => {
      // Spawn failures (ENOENT, EACCES) arrive here without an "exit".
      if (child.pid === undefined) settle(`spawn error: ${(error as NodeJS.ErrnoException).code ?? error.message}`);
    });
    child.once("exit", (code, signal) => settle(signal !== null ? `signal=${signal}` : `code=${code}`));
    if (child.pid !== undefined) {
      this.#log(`host started pid=${child.pid}`);
      this.#set({ pid: child.pid });
    }
  }

  /** Polls the announced host's /health until it answers exactly 200 (redirects are not followed). */
  async #waitReady(generation: number, announce: HostAnnounce): Promise<void> {
    const step = this.#opts.healthIntervalMs ?? 200;
    const url = this.#opts.healthUrl(announce);
    while (generation === this.#generation && this.#child !== null && this.#state.phase === "starting") {
      try {
        const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(2_000) });
        await response.body?.cancel();
        if (response.status === 200 && generation === this.#generation) {
          this.#healthy = true;
          this.#maybeReady(generation);
          return;
        }
      } catch {
        // Not listening yet.
      }
      await sleep(step);
    }
  }

  /** Ready = the start line and /health 200, both from the current host process (owner contract). */
  #maybeReady(generation: number): void {
    if (generation !== this.#generation || this.#state.phase !== "starting") return;
    if (!this.#healthy || this.#state.announce === null) return;
    this.#reachedReady = true;
    this.#log("host ready");
    this.#set({ phase: "ready" });
  }

  #onExit(generation: number, reason: string, pid: number | null): void {
    if (generation !== this.#generation) return;
    const wasUp = this.#reachedReady;
    this.#child = null;
    this.#log(`host exited ${reason}`);
    if (this.#stopping) {
      this.#set({ lastExit: reason, pid: null });
      return;
    }
    if (reason === "code=0" && !wasUp) {
      this.#log("host exited cleanly before it was ready; not restarting");
      this.#set({ phase: "exited", lastExit: reason, pid: null });
      this.#recoveryActive = true;
      this.#recovering = (pid === null ? Promise.resolve(true) : killGroup(pid, this.#opts.stopGraceMs ?? 5_000, this.#opts.killWaitMs))
        .then(() => undefined)
        .finally(() => {
          this.#recoveryActive = false;
        });
      return;
    }
    // Show the host as down right away; cleaning its leftover group can take the grace period.
    this.#set({ phase: "restarting", lastExit: reason, pid: null });
    this.#recoveryActive = true;
    this.#recovering = this.#recover(pid, generation).finally(() => {
      this.#recoveryActive = false;
    });
  }

  async #recover(pid: number | null, generation: number): Promise<void> {
    // Agents the dead host started are still in its group; the host ending ends that work.
    if (pid !== null) await killGroup(pid, this.#opts.stopGraceMs ?? 5_000, this.#opts.killWaitMs);
    if (this.#stopping || generation !== this.#generation) return;
    const now = (this.#opts.now ?? Date.now)();
    const previousKey = this.#record.notifiedKey;
    this.#record = recordRestart(this.#record, now, String(generation), this.#state.lastExit ?? "unknown");
    if (this.#record.notifiedKey !== undefined && this.#record.notifiedKey !== previousKey) {
      this.#log(`host keeps exiting with ${this.#record.notifiedKey} (slow crash pattern)`);
    }
    if (this.#record.pause !== null) {
      this.#log(`host crash loop: ${this.#record.attempts.length} restarts in 10 min, paused`);
      this.#set({ phase: "crash-loop", restarts: this.#record.attempts.length });
      return;
    }
    const attempt = this.#record.attempt;
    const delay = this.#opts.restartDelayMs?.(attempt - 1) ?? restartDelayMs(attempt - 1, Math.random());
    this.#log(`host restart ${attempt} in ${delay} ms`);
    this.#set({ phase: "restarting", restarts: this.#record.attempts.length });
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      if (!this.#stopping) this.#spawn();
    }, delay);
  }

  #set(patch: Partial<HostState>): void {
    this.#state = { ...this.#state, ...patch };
    this.#opts.onState?.(this.#state);
  }

  #log(line: string): void {
    this.#opts.log?.(line);
  }
}

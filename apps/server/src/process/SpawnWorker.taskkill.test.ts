import * as NodeEvents from "node:events";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";
import { SpawnWorkerPool } from "./SpawnWorker.ts";

it.live("settles a dead worker's child when Windows taskkill hangs", () =>
  Effect.promise(async () => {
    const pool = new SpawnWorkerPool("win32");
    const child = pool.spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      stdio: "ignore",
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    });
    const realKill = process.kill.bind(process);
    try {
      await NodeEvents.once(child, "spawn");
      const childPid = child.pid;
      expect(childPid).toBeDefined();
      const taskkill = Object.assign(new NodeEvents.EventEmitter(), { pid: 12346, kill: vi.fn() });
      vi.spyOn(pool, "spawn").mockReturnValue(taskkill as unknown as ReturnType<typeof pool.spawn>);
      const kill = vi
        .spyOn(process, "kill")
        .mockImplementation((pid, signal) => (pid === taskkill.pid ? true : realKill(pid, signal)));
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      const exited = vi.fn();
      child.once("exit", exited);
      vi.useFakeTimers();
      child.worker.fail(new Error("fixture worker died"));
      expect(exited).not.toHaveBeenCalled();
      vi.advanceTimersByTime(5_000);
      expect(kill).toHaveBeenCalledWith(taskkill.pid, "SIGKILL");
      expect(kill).toHaveBeenCalledWith(childPid, "SIGKILL");
      expect(exited).toHaveBeenCalledOnce();
      expect(warning).toHaveBeenCalledOnce();
      taskkill.emit("exit", 0);
      expect(exited).toHaveBeenCalledOnce();
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
      if (child.pid !== undefined && !child.exited) {
        try {
          realKill(child.pid, "SIGKILL");
        } catch {}
      }
      pool.close();
    }
  }),
);

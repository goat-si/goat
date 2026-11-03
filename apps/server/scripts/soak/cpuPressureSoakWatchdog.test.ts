// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";
import { guardChild } from "@goat/shared/errorGuards";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

// oxlint-disable-next-line goat/no-global-process-runtime -- Process groups are unavailable on Windows.
it.live.skipIf(process.platform === "win32")(
  "kills the server group after a SIGKILLed driver (#2468)",
  () =>
    Effect.promise(async () => {
      const moduleUrl = new URL("./cpuPressureSoak.ts", import.meta.url).href;
      const grandchildCode = `require("node:net").createServer().listen(0, "127.0.0.1", () => process.stdout.write("grandchild-ready\\n"));`;
      const serverCode = `const {spawn} = require("node:child_process"); const fs = require("node:fs"); const c = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildCode)}], {stdio:["ignore",2,"ignore"]}); c.once("spawn", () => { fs.closeSync(2); require("node:net").createServer().listen(0, "127.0.0.1", () => process.stdout.write("server-ready\\n")); });`;
      const driverCode = `const m = await import(${JSON.stringify(moduleUrl)}); const owned = await m.spawnWatchedServer(process.execPath, ["-e", ${JSON.stringify(serverCode)}], {stdio:["ignore",3,4]}, 1); console.log("fixture-ready " + owned.server.child.pid); process.stdin.resume();`;
      const driver = guardChild(
        NodeChildProcess.spawn(process.execPath, ["--input-type=module", "-e", driverCode], {
          stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
        }),
        () => {},
      );
      const exited = new Promise<NodeJS.Signals | null>((resolve) =>
        driver.once("exit", (_, signal) => resolve(signal)),
      );
      let stderr = "";
      driver.stderr.setEncoding("utf8");
      driver.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      const lines = NodeReadline.createInterface({ input: driver.stdout })[Symbol.asyncIterator]();
      const serverPipe = driver.stdio[3];
      const grandchildPipe = driver.stdio[4];
      if (!serverPipe || !("read" in serverPipe) || !grandchildPipe || !("read" in grandchildPipe))
        throw new Error("fixture pipes unavailable");
      const serverLines = NodeReadline.createInterface({ input: serverPipe })[
        Symbol.asyncIterator
      ]();
      const grandchildLines = NodeReadline.createInterface({ input: grandchildPipe })[
        Symbol.asyncIterator
      ]();
      let pgid: number | undefined;
      const failures: unknown[] = [];
      try {
        const line = await lines.next();
        if (line.done) {
          await stderrEnded;
          throw new Error(`driver exited before readiness: ${stderr}`);
        }
        expect(line.value).toMatch(/^fixture-ready \d+$/);
        pgid = Number(line.value.split(" ")[1]);
        expect((await serverLines.next()).value).toBe("server-ready");
        expect((await grandchildLines.next()).value).toBe("grandchild-ready");
        driver.kill("SIGKILL");
        expect(await exited).toBe("SIGKILL");
        expect((await lines.next()).value).toBe("watchdog-killed");
        expect((await serverLines.next()).done).toBe(true);
        expect((await grandchildLines.next()).done).toBe(true);
      } catch (error) {
        failures.push(error);
      }
      try {
        if (driver.exitCode === null && driver.signalCode === null) driver.kill("SIGKILL");
        await exited;
      } catch (error) {
        failures.push(error);
      }
      if (pgid !== undefined) {
        try {
          process.kill(-pgid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") failures.push(error);
        }
      }
      if (failures.length) throw failures[0];
    }),
);

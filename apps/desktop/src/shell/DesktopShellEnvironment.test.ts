import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  DesktopShellEnvironment,
  discoverWithRetries,
  installPosixEnvironment,
  LiveShellProbes,
  runCommandOutput,
  type CommandRunner,
} from "./DesktopShellEnvironment.ts";
import { buildEnvironmentCaptureCommand, extractEnvironmentValues } from "./shellEnvironmentCapture.ts";

const HOME = "/Users/me";
const WELL_KNOWN = ":/Users/me/.local/bin:/Users/me/.bun/bin:/opt/homebrew/bin:/usr/local/bin";

/** A login shell that answers with the given variables (marker output as the real capture prints it). */
function answering(values: Record<string, string>, calls: string[] = []): CommandRunner {
  return async (command) => {
    calls.push(command);
    if (command === "/bin/launchctl") return "";
    let out = "";
    for (const [name, value] of Object.entries(values)) out += `__GOAT_ENV_${name}_START__\n${value}\n__GOAT_ENV_${name}_END__\n`;
    return out;
  };
}

const options = (run: CommandRunner, cacheFile = join(mkdtempSync(join(tmpdir(), "goat2-shellenv-")), "cache.json")) => ({
  platform: "darwin" as const,
  homeDirectory: HOME,
  cacheFile,
  run,
  userShell: "/bin/zsh",
});

describe("installPosixEnvironment (v1 rules)", () => {
  it("puts the login shell PATH first, then the inherited one, without repeats", async () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", SHELL: "/bin/zsh" };
    const answered = await installPosixEnvironment(env, options(answering({ PATH: "/opt/homebrew/bin:/Users/me/.local/bin:/usr/bin" })));
    assert.equal(answered, true);
    assert.equal(env.PATH, "/opt/homebrew/bin:/Users/me/.local/bin:/usr/bin:/bin");
  });

  it("falls back to launchctl's PATH when no shell answers, and the answer does not count as the person's", async () => {
    const calls: string[] = [];
    const run: CommandRunner = async (command) => {
      calls.push(command);
      return command === "/bin/launchctl" ? "/launchd/bin:/usr/bin\n" : "";
    };
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", SHELL: "/bin/zsh" };
    assert.equal(await installPosixEnvironment(env, options(run)), false);
    assert.equal(env.PATH, "/launchd/bin:/usr/bin:/bin");
    assert.deepEqual(calls, ["/bin/zsh", "/bin/launchctl"], "the fallback shell is the same zsh, tried once");
  });

  it("does not start the next candidate shell while an earlier probe has not exited", async () => {
    const calls: string[] = [];
    const probes = new LiveShellProbes();
    const run: CommandRunner = async (command, _args, opts) => {
      calls.push(command);
      if (command === "/bin/launchctl") return "/launchd/bin\n";
      // A timed-out probe whose exit is never seen (stuck after SIGKILL).
      opts.probes?.track({ once: () => undefined });
      return "";
    };
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", SHELL: "/bin/bash" };
    assert.equal(await installPosixEnvironment(env, { ...options(run), probes }), false);
    assert.deepEqual(calls, ["/bin/bash", "/bin/launchctl"], "a second login shell ran beside a live one");
    assert.equal(env.PATH, "/launchd/bin:/usr/bin");
  });


  it("keeps inherited values, prefers the shell's for preferred names, and hydrates locale together", async () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", SHELL: "/bin/zsh", SSH_AUTH_SOCK: "/inherited.sock", JAVA_HOME: "/inherited/java" };
    await installPosixEnvironment(
      env,
      options(answering({ PATH: "/usr/bin", SSH_AUTH_SOCK: "/shell.sock", JAVA_HOME: "/shell/java", PNPM_HOME: "/shell/pnpm", __MISE_DIFF: "d", LANG: "ko_KR.UTF-8" })),
    );
    assert.equal(env.SSH_AUTH_SOCK, "/inherited.sock");
    assert.equal(env.JAVA_HOME, "/inherited/java");
    assert.equal(env.PNPM_HOME, "/shell/pnpm");
    assert.equal(env.__MISE_DIFF, "d");
    assert.equal(env.LANG, "ko_KR.UTF-8");
  });

  it("sets UTF-8 LC_CTYPE when neither launchd nor the shell gives a locale", async () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", SHELL: "/bin/zsh" };
    await installPosixEnvironment(env, options(answering({ PATH: "/usr/bin" })));
    assert.equal(env.LC_CTYPE, "en_US.UTF-8");
  });
});

describe("DesktopShellEnvironment", () => {
  it("fills the host env, caches a good answer, and a later launch starts from the cache", async () => {
    const inherited = { PATH: "/usr/bin:/bin", SHELL: "/bin/zsh", HOME };
    const opts = options(answering({ PATH: "/shell/bin:/usr/bin" }));
    const target: NodeJS.ProcessEnv = { ...inherited, GOAT2_HOST_TOKEN: "t" };
    const first = new DesktopShellEnvironment(inherited, opts);
    assert.equal(first.installCached(target), false);
    assert.equal(target.PATH, "/usr/bin:/bin" + WELL_KNOWN, "no cache: inherited PATH + well-known folders");
    assert.equal(await first.refresh(target), true);
    assert.equal(target.PATH, "/shell/bin:/usr/bin:/bin" + WELL_KNOWN);
    assert.equal(target.GOAT2_HOST_TOKEN, "t", "non-shell names untouched");
    assert.equal(existsSync(opts.cacheFile), true);

    const next: NodeJS.ProcessEnv = { ...inherited };
    const second = new DesktopShellEnvironment(inherited, { ...opts, run: answering({}) });
    assert.equal(second.installCached(next), true);
    assert.equal(next.PATH, "/shell/bin:/usr/bin:/bin" + WELL_KNOWN);
  });

  it("ignores a cache made for another shell, and does not cache an answer from no shell", async () => {
    const opts = options(answering({ PATH: "/shell/bin" }));
    await new DesktopShellEnvironment({ PATH: "/usr/bin", SHELL: "/bin/zsh" }, opts).refresh({});
    const other = new DesktopShellEnvironment({ PATH: "/usr/bin", SHELL: "/bin/bash" }, opts);
    assert.equal(other.installCached({}), false);

    const silent = options(async () => "");
    const before = existsSync(silent.cacheFile);
    await new DesktopShellEnvironment({ PATH: "/usr/bin", SHELL: "/bin/zsh" }, silent).refresh({});
    assert.equal(existsSync(silent.cacheFile), before);
  });

  it("a refresh drops values the shell no longer sets", async () => {
    const inherited = { PATH: "/usr/bin", SHELL: "/bin/zsh" };
    const target: NodeJS.ProcessEnv = { ...inherited };
    await new DesktopShellEnvironment(inherited, options(answering({ PATH: "/usr/bin", PNPM_HOME: "/p" }))).refresh(target);
    assert.equal(target.PNPM_HOME, "/p");
    await new DesktopShellEnvironment(inherited, options(answering({ PATH: "/usr/bin" }))).refresh(target);
    assert.equal(target.PNPM_HOME, undefined);
  });

  it("caches only v1's allowlist: session values (SSH_AUTH_SOCK, locale) are never restored", async () => {
    const inherited = { PATH: "/usr/bin", SHELL: "/bin/zsh" };
    const opts = options(answering({ PATH: "/shell/bin", SSH_AUTH_SOCK: "/old-session.sock", LANG: "ko_KR.UTF-8", JAVA_HOME: "/shell/java" }));
    await new DesktopShellEnvironment(inherited, opts).refresh({});
    const cached = JSON.parse(readFileSync(opts.cacheFile, "utf8")) as { environment: Record<string, string> };
    assert.deepEqual(Object.keys(cached.environment).sort(), ["JAVA_HOME", "PATH"]);

    // Next launch: the session's own values win; only PATH (and __MISE_DIFF) are laid over them.
    const nextInherited = { PATH: "/usr/bin:/session/bin", SHELL: "/bin/zsh", JAVA_HOME: "/session/java", SSH_AUTH_SOCK: "/new-session.sock" };
    const target: NodeJS.ProcessEnv = { ...nextInherited };
    assert.equal(new DesktopShellEnvironment(nextInherited, { ...opts, run: answering({}) }).installCached(target), true);
    assert.equal(target.SSH_AUTH_SOCK, "/new-session.sock");
    assert.equal(target.JAVA_HOME, "/session/java");
    assert.equal(target.PATH, "/shell/bin:/usr/bin:/session/bin" + WELL_KNOWN, "cached PATH first, then the inherited one");
  });

  it("a refresh whose login shell does not answer keeps the cached answer", async () => {
    const inherited = { PATH: "/usr/bin", SHELL: "/bin/zsh" };
    const opts = options(answering({ PATH: "/shell/bin:/usr/bin" }));
    await new DesktopShellEnvironment(inherited, opts).refresh({});
    const target: NodeJS.ProcessEnv = { ...inherited };
    const later = new DesktopShellEnvironment(inherited, { ...opts, run: async () => "" });
    assert.equal(later.installCached(target), true);
    assert.equal(await later.refresh(target), false);
    assert.equal(target.PATH, "/shell/bin:/usr/bin" + WELL_KNOWN);
  });

  it("a malformed or oversized cache is a miss, never an exception", () => {
    const inherited = { PATH: "/usr/bin", SHELL: "/bin/zsh" };
    const dir = mkdtempSync(join(tmpdir(), "goat2-badcache-"));
    const cacheFile = join(dir, "cache.json");
    const key = JSON.stringify(["darwin", HOME, "/bin/zsh", ""]);
    for (const text of [
      "null",
      "[]",
      "{",
      JSON.stringify({ version: 1, key, environment: null }),
      JSON.stringify({ version: 1, key, environment: [] }),
      JSON.stringify({ version: 1, key, environment: { PATH: 7 } }),
      JSON.stringify({ version: 2, key, environment: { PATH: "/x" } }),
      JSON.stringify({ version: 1, key, environment: { PATH: "/x".padEnd(1024 * 1024 + 10, "x") } }),
    ]) {
      writeFileSync(cacheFile, text);
      const target: NodeJS.ProcessEnv = { ...inherited };
      assert.equal(new DesktopShellEnvironment(inherited, { ...options(answering({})), cacheFile }).installCached(target), false, text.slice(0, 40));
      assert.equal(target.PATH, "/usr/bin" + WELL_KNOWN);
    }
  });
});

describe("login shell probe, for real", () => {
  it("counts a probe as live until its exit is seen, killed ones included", async () => {
    const probes = new LiveShellProbes();
    const pending = runCommandOutput("/bin/sh", ["-c", "sleep 5"], { env: { PATH: "/usr/bin:/bin" }, timeoutMs: 300, probes });
    assert.equal(probes.allGone, false);
    assert.equal(await pending, "");
    for (let i = 0; i < 40 && !probes.allGone; i++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(probes.allGone, true);
  });

  for (const shell of ["/bin/zsh", "/bin/bash"]) {
    it(`${shell} -ilc answers with its PATH through the v1 capture command`, async () => {
      const out = await runCommandOutput(shell, ["-ilc", buildEnvironmentCaptureCommand(shell, ["PATH", "HOME"])], {
        env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/" },
        timeoutMs: 15_000,
      });
      const values = extractEnvironmentValues(out, ["PATH", "HOME"]);
      assert.ok(values.PATH && values.PATH.includes("/usr/bin"), `no PATH from ${shell}`);
      assert.equal(values.HOME, process.env.HOME);
    });
  }

  it("a login shell that hangs is killed with its children at the deadline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goat2-hangshell-"));
    const shell = join(dir, "hang-shell");
    const pidFile = join(dir, "child.pid");
    writeFileSync(shell, `#!/bin/sh\nsleep 30 &\necho $! > ${pidFile}\nwait\n`);
    chmodSync(shell, 0o755);
    const started = Date.now();
    const out = await runCommandOutput(shell, ["-ilc", "true"], { env: { PATH: "/usr/bin:/bin" }, timeoutMs: 500 });
    assert.equal(out, "");
    assert.ok(Date.now() - started < 3_000);
    const child = Number(readFileSync(pidFile, "utf8"));
    // A killed process can linger as a zombie until launchd reaps it; poll instead of one fixed wait.
    const gone = () => {
      try {
        process.kill(child, 0);
        return false;
      } catch {
        return true;
      }
    };
    for (let i = 0; i < 40 && !gone(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(gone(), "the shell's child outlived the probe");
  });
});

describe("retries (v1 discoverWithRetries)", () => {
  it("retries with v1's growing gaps until an answer, POSIX only", async () => {
    const slept: number[] = [];
    const results = [false, false, true];
    const answered = await discoverWithRetries(async () => results.shift() ?? false, "darwin", () => true, {
      sleep: async (ms) => void slept.push(ms),
    });
    assert.equal(answered, true);
    assert.deepEqual(slept, [30_000, 120_000]);

    let calls = 0;
    assert.equal(await discoverWithRetries(async () => (calls++, false), "win32", () => true, { sleep: async () => {} }), false);
    assert.equal(calls, 1);
  });

  it("stops when an earlier probe is not known to have exited, and after the last gap", async () => {
    let calls = 0;
    assert.equal(await discoverWithRetries(async () => (calls++, false), "darwin", () => false, { sleep: async () => {} }), false);
    assert.equal(calls, 1);
    calls = 0;
    assert.equal(await discoverWithRetries(async () => (calls++, false), "darwin", () => true, { sleep: async () => {} }), false);
    assert.equal(calls, 4, "one discovery + three retries");
  });

  it("startDiscovery settles first with the first answer; a later answer updates the host env and is reported", async () => {
    let call = 0;
    const run: CommandRunner = async (command) => {
      if (command === "/bin/launchctl") return "";
      call += 1;
      return call >= 2 ? "__GOAT_ENV_PATH_START__\n/late/bin:/usr/bin\n__GOAT_ENV_PATH_END__\n" : "";
    };
    const inherited = { PATH: "/usr/bin", SHELL: "/bin/zsh" };
    const target: NodeJS.ProcessEnv = { ...inherited };
    const environment = new DesktopShellEnvironment(inherited, options(run));
    let late = 0;
    const discovery = environment.startDiscovery(target, { onLateAnswer: () => void late++, sleep: async () => {} });
    assert.equal(await discovery.first, false);
    assert.equal(await discovery.settled, true);
    assert.equal(late, 1);
    assert.equal(target.PATH, "/late/bin:/usr/bin" + WELL_KNOWN);
  });
});

// @effect-diagnostics nodeBuiltinImport:off -- Executes the remote POSIX shell against isolated fixtures.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { REMOTE_HOME_OWNER_WAIT } from "./remoteHomeOwnerWait.ts";

it("fails closed for unexpected successful ownership probe output", () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-home-unexpected-"));
  try {
    const state = NodePath.join(home, "state");
    NodeFS.mkdirSync(state);
    NodeFS.mkdirSync(NodePath.join(home, "runtime"));
    NodeFS.writeFileSync(NodePath.join(home, "runtime/service-update-handoff.json"), "live");
    const script = `${REMOTE_HOME_OWNER_WAIT}
date() { printf '1000\\n'; }
sleep() { :; }
live_fact() { return 1; }
home_probe() { printf '%s\\n' "$TEST_PROBE_OUTPUT"; return 0; }
wait_for_home_owner
`;
    for (const value of ["inspection-error", "timeout", "unexpected"]) {
      const result = NodeChildProcess.spawnSync("/bin/sh", ["-c", script], {
        env: {
          ...process.env,
          TEST_PROBE_OUTPUT: value,
          DEFAULT_SERVER_HOME: home,
          STATE_DIR: state,
          RUNNER_CANDIDATE_FILE: NodePath.join(state, "candidate"),
          DEFAULT_RUNTIME_FILE: NodePath.join(home, "runtime.json"),
          PORT_FILE: NodePath.join(state, "port"),
          PID_FILE: NodePath.join(state, "pid"),
        },
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Cannot inspect GOAT home ownership");
    }
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
});

it("fails closed when the ownership helper reports its deadline", () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-home-deadline-"));
  try {
    const state = NodePath.join(home, "state");
    const runtime = NodePath.join(home, "runtime");
    NodeFS.mkdirSync(state);
    NodeFS.mkdirSync(runtime);
    NodeFS.writeFileSync(NodePath.join(runtime, "service-update-handoff.json"), "live");
    const candidate = NodePath.join(state, "candidate.pin");
    NodeFS.writeFileSync(candidate, "#!/bin/sh\nprintf 'timeout\\n'\nexit 124\n", { mode: 0o755 });
    const script = `${REMOTE_HOME_OWNER_WAIT}\nwait_for_home_owner\n`;
    const result = NodeChildProcess.spawnSync("/bin/sh", ["-c", script], {
      env: {
        ...process.env,
        DEFAULT_SERVER_HOME: home,
        STATE_DIR: state,
        RUNNER_CANDIDATE_FILE: NodePath.join(state, "candidate"),
        DEFAULT_RUNTIME_FILE: NodePath.join(home, "runtime.json"),
        PORT_FILE: NodePath.join(state, "port"),
        PID_FILE: NodePath.join(state, "pid"),
      },
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Cannot inspect GOAT home ownership");
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
});

it("fails closed when the ownership helper exits 2 without output", () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-home-error-"));
  try {
    const state = NodePath.join(home, "state");
    NodeFS.mkdirSync(state);
    NodeFS.mkdirSync(NodePath.join(home, "runtime"));
    NodeFS.writeFileSync(NodePath.join(home, "runtime/service-update-handoff.json"), "live");
    NodeFS.writeFileSync(NodePath.join(state, "candidate.pin"), "#!/bin/sh\nexit 2\n", {
      mode: 0o755,
    });
    const result = NodeChildProcess.spawnSync(
      "/bin/sh",
      ["-c", `${REMOTE_HOME_OWNER_WAIT}\nwait_for_home_owner\n`],
      {
        env: {
          ...process.env,
          DEFAULT_SERVER_HOME: home,
          STATE_DIR: state,
          RUNNER_CANDIDATE_FILE: NodePath.join(state, "candidate"),
          DEFAULT_RUNTIME_FILE: NodePath.join(home, "runtime.json"),
          PORT_FILE: NodePath.join(state, "port"),
          PID_FILE: NodePath.join(state, "pid"),
        },
        encoding: "utf8",
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Cannot inspect GOAT home ownership");
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
});

it("fails closed when an older helper exits 1 with CLI usage output", () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-home-old-helper-"));
  try {
    const state = NodePath.join(home, "state");
    NodeFS.mkdirSync(state);
    NodeFS.mkdirSync(NodePath.join(home, "runtime"));
    NodeFS.writeFileSync(NodePath.join(home, "runtime/service-update-handoff.json"), "live");
    NodeFS.writeFileSync(
      NodePath.join(state, "candidate.pin"),
      "#!/bin/sh\nprintf 'USAGE\\n'\nexit 1\n",
      {
        mode: 0o755,
      },
    );
    const result = NodeChildProcess.spawnSync(
      "/bin/sh",
      ["-c", `${REMOTE_HOME_OWNER_WAIT}\nwait_for_home_owner\n`],
      {
        env: {
          ...process.env,
          DEFAULT_SERVER_HOME: home,
          STATE_DIR: state,
          RUNNER_CANDIDATE_FILE: NodePath.join(state, "candidate"),
          DEFAULT_RUNTIME_FILE: NodePath.join(home, "runtime.json"),
          PORT_FILE: NodePath.join(state, "port"),
          PID_FILE: NodePath.join(state, "pid"),
        },
        encoding: "utf8",
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Cannot inspect GOAT home ownership");
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
});

it("continues launch when an ownership probe exits 1 without output", () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-home-free-probe-"));
  try {
    const state = NodePath.join(home, "state");
    NodeFS.mkdirSync(state);
    NodeFS.mkdirSync(NodePath.join(home, "runtime"));
    NodeFS.writeFileSync(NodePath.join(home, "runtime/service-update-handoff.json"), "stale");
    NodeFS.writeFileSync(NodePath.join(state, "candidate.pin"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
    const result = NodeChildProcess.spawnSync(
      "/bin/sh",
      ["-c", `${REMOTE_HOME_OWNER_WAIT}\nwait_for_home_owner && printf 'launch\\n'\n`],
      {
        env: {
          ...process.env,
          DEFAULT_SERVER_HOME: home,
          STATE_DIR: state,
          RUNNER_CANDIDATE_FILE: NodePath.join(state, "candidate"),
          DEFAULT_RUNTIME_FILE: NodePath.join(home, "runtime.json"),
          PORT_FILE: NodePath.join(state, "port"),
          PID_FILE: NodePath.join(state, "pid"),
        },
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("launch\n");
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
});

it("fails closed when exit 1 contains a NUL byte that a shell would discard", () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-home-nul-probe-"));
  try {
    const state = NodePath.join(home, "state");
    NodeFS.mkdirSync(state);
    NodeFS.mkdirSync(NodePath.join(home, "runtime"));
    NodeFS.writeFileSync(NodePath.join(home, "runtime/service-update-handoff.json"), "live");
    NodeFS.writeFileSync(
      NodePath.join(state, "candidate.pin"),
      "#!/bin/sh\nprintf '\\000'\nexit 1\n",
      { mode: 0o755 },
    );
    const result = NodeChildProcess.spawnSync(
      "/bin/sh",
      ["-c", `${REMOTE_HOME_OWNER_WAIT}\nwait_for_home_owner\n`],
      {
        env: {
          ...process.env,
          DEFAULT_SERVER_HOME: home,
          STATE_DIR: state,
          RUNNER_CANDIDATE_FILE: NodePath.join(state, "candidate"),
          DEFAULT_RUNTIME_FILE: NodePath.join(home, "runtime.json"),
          PORT_FILE: NodePath.join(state, "port"),
          PID_FILE: NodePath.join(state, "pid"),
        },
        encoding: "utf8",
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Cannot inspect GOAT home ownership");
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
});

it("fails closed when an owned response contains a NUL byte", () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-home-nul-owned-"));
  try {
    const state = NodePath.join(home, "state");
    NodeFS.mkdirSync(state);
    NodeFS.mkdirSync(NodePath.join(home, "runtime"));
    NodeFS.writeFileSync(NodePath.join(home, "runtime/service-update-handoff.json"), "live");
    NodeFS.writeFileSync(
      NodePath.join(state, "candidate.pin"),
      "#!/bin/sh\nprintf '\\000'\nexit 0\n",
      { mode: 0o755 },
    );
    const script = `${REMOTE_HOME_OWNER_WAIT}
date() { printf '1000\\n'; }
sleep() { if [ "$1" = 1 ]; then :; else command sleep "$1"; fi; }
live_fact() { return 1; }
wait_for_home_owner
`;
    const result = NodeChildProcess.spawnSync("/bin/sh", ["-c", script], {
      env: {
        ...process.env,
        DEFAULT_SERVER_HOME: home,
        STATE_DIR: state,
        RUNNER_CANDIDATE_FILE: NodePath.join(state, "candidate"),
        DEFAULT_RUNTIME_FILE: NodePath.join(home, "runtime.json"),
        PORT_FILE: NodePath.join(state, "port"),
        PID_FILE: NodePath.join(state, "pid"),
      },
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Cannot inspect GOAT home ownership");
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
});

it("kills a stalled helper that ignores TERM and leaves no child", () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-home-stalled-"));
  try {
    const state = NodePath.join(home, "state");
    const runtime = NodePath.join(home, "runtime");
    const bin = NodePath.join(home, "bin");
    for (const dir of [state, runtime, bin]) NodeFS.mkdirSync(dir);
    NodeFS.writeFileSync(NodePath.join(runtime, "service-update-handoff.json"), "live");
    NodeFS.writeFileSync(
      NodePath.join(state, "candidate.pin"),
      '#!/bin/sh\ntrap "" TERM\nprintf "%s" "$$" >"$STATE_DIR/helper-pid"\nwhile :; do :; done\n',
      { mode: 0o755 },
    );
    NodeFS.writeFileSync(NodePath.join(bin, "date"), "#!/bin/sh\nprintf '1000\\n'\n", {
      mode: 0o755,
    });
    NodeFS.writeFileSync(
      NodePath.join(bin, "sleep"),
      '#!/bin/sh\nwhile [ ! -s "$STATE_DIR/helper-pid" ]; do :; done\nexit 0\n',
      { mode: 0o755 },
    );
    const result = NodeChildProcess.spawnSync(
      "/bin/sh",
      ["-c", `${REMOTE_HOME_OWNER_WAIT}\nwait_for_home_owner\n`],
      {
        env: {
          ...process.env,
          PATH: `${bin}:/usr/bin:/bin`,
          DEFAULT_SERVER_HOME: home,
          STATE_DIR: state,
          RUNNER_CANDIDATE_FILE: NodePath.join(state, "candidate"),
          DEFAULT_RUNTIME_FILE: NodePath.join(home, "runtime.json"),
          PORT_FILE: NodePath.join(state, "port"),
          PID_FILE: NodePath.join(state, "pid"),
        },
        encoding: "utf8",
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Cannot inspect GOAT home ownership");
    const pid = Number(NodeFS.readFileSync(NodePath.join(state, "helper-pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
});

it("fails closed when the helper exceeds the output cap", () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-home-output-cap-"));
  try {
    const state = NodePath.join(home, "state");
    NodeFS.mkdirSync(state);
    NodeFS.mkdirSync(NodePath.join(home, "runtime"));
    NodeFS.writeFileSync(NodePath.join(home, "runtime/service-update-handoff.json"), "live");
    NodeFS.writeFileSync(
      NodePath.join(state, "candidate.pin"),
      "#!/bin/sh\nexec dd if=/dev/zero bs=65536 count=1\n",
      { mode: 0o755 },
    );
    const result = NodeChildProcess.spawnSync(
      "/bin/sh",
      ["-c", `${REMOTE_HOME_OWNER_WAIT}\nwait_for_home_owner\n`],
      {
        env: {
          ...process.env,
          DEFAULT_SERVER_HOME: home,
          STATE_DIR: state,
          RUNNER_CANDIDATE_FILE: NodePath.join(state, "candidate"),
          DEFAULT_RUNTIME_FILE: NodePath.join(home, "runtime.json"),
          PORT_FILE: NodePath.join(state, "port"),
          PID_FILE: NodePath.join(state, "pid"),
        },
        encoding: "utf8",
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Cannot inspect GOAT home ownership");
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
});

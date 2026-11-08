// The facts helpers run shells synchronously; the Effect spawner adds nothing to these checks.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import {
  REMOTE_PROTOCOL_TOKEN_SCRIPT,
  REMOTE_RUNNER_HINT_SCRIPT,
  RUNNER_HINT_END,
} from "./runtimeFactsScripts.ts";
import { buildRemoteGoatRunnerScript } from "./tunnel.ts";

// The facts helpers replaced commands that cost about 50 ms each under MSYS; each must answer
// exactly as the command it replaced, and remembered keys must never outlive a write they see.
describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("fact helpers", () => {
  const scripts = REMOTE_RUNNER_HINT_SCRIPT + "\n" + REMOTE_PROTOCOL_TOKEN_SCRIPT;
  const quote = (token: string) => "'" + token.replaceAll("'", "'\\''") + "'";
  const runIn = (shell: string, body: string, env: Record<string, string> = {}) => {
    const result = NodeChildProcess.spawnSync(shell, ["-c", "set -eu\n" + scripts + "\n" + body], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };

  it.each(["dash", "bash"])("match the commands they replace (%s)", (shell) => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-fact-helpers-"));
    try {
      const built = {
        // Runners this build writes: read up to their end-of-declarations line, they must read as
        // the whole file does, so no declaration follows that line.
        builtArchive: buildRemoteGoatRunnerScript({ archiveVersion: "1.2.3" }),
        builtMirror: buildRemoteGoatRunnerScript({
          archiveVersion: "1.2.3",
          releaseBaseUrl: "https://example.invalid/mirror/",
        }),
        builtNode: buildRemoteGoatRunnerScript({
          nodeScriptPath: "/srv/cli.mjs",
          nodeEngineRange: ">=22",
        }),
      };
      const files: Record<string, string> = {
        both: "T3_ARCHIVE_VERSION='0.9.0'\nGOAT_ARCHIVE_VERSION='1.2.3'\n",
        legacy: "T3_ARCHIVE_VERSION='0.9.0'\n",
        unquoted: "GOAT_ARCHIVE_VERSION=1.2.3\nT3_ARCHIVE_VERSION='0.9.0'\n",
        duplicate: "GOAT_ARCHIVE_VERSION='1.2.3'\nGOAT_ARCHIVE_VERSION='1.2.4'\n",
        inner:
          "GOAT_ARCHIVE_VERSION='a'b'\n  GOAT_ARCHIVE_VERSION='x'\nGOAT_ARCHIVE_VERSION=''\nGOAT_ARCHIVE_VERSION='\n",
        prefix: "GOAT_ARCHIVE_VERSIONX='1'\nT3_ARCHIVE_VERSION='0.9.0'",
        empty: "",
        record: '{\n  "pid": 4242,\n  "port" : 3773,\n  "origin": "http://127.0.0.1:3773"\n}\n\n',
        oneLine: '{"pid":12,"port":"x","port":  77}',
        repeated: '{"pid": 1, "child": {"pid": "z"}, "port": 9}',
        crlf: '{"pid":5,\r\n"port":6}\r\n',
        noNewline: "123",
        trailing: "123\n\n\n",
        inside: "1\n\n2\n",
        // Archive runners declare an empty node script; node runners declare one.
        archiveRunner:
          "#!/bin/sh\nGOAT_NODE_SCRIPT_PATH=''\nGOAT_ARCHIVE_VERSION='1.2.3'\nexec x\n",
        nodeRunner: "GOAT_NODE_SCRIPT_PATH='/srv/cli.mjs'\nGOAT_ARCHIVE_VERSION='1.2.3'\n",
        legacyNode: "T3_NODE_SCRIPT_PATH='/srv/cli.mjs'\nT3_ARCHIVE_VERSION='0.9.0'\n",
        emptyBoth: "GOAT_NODE_SCRIPT_PATH=''\nGOAT_NODE_SCRIPT_PATH=''\nGOAT_ARCHIVE_VERSION=''\n",
        crlfRunner:
          "GOAT_NODE_SCRIPT_PATH='/a'\r\nGOAT_ARCHIVE_VERSION='1.2.3'\r\nT3_ARCHIVE_VERSION='0.9.0'\n",
        literal: "GOAT_ARCHIVE_VERSION='a\\b *?[x] $(id) \"q\"'\nGOAT_NODE_SCRIPT_PATH='\\'\n",
        unterminated: "GOAT_NODE_SCRIPT_PATH=''\nGOAT_ARCHIVE_VERSION='1.2.3'",
        ...built,
        // An end line read with CRLF is not the end line, so the whole file is read.
        crlfEnd: `GOAT_ARCHIVE_VERSION='1.2.3'\r\n${RUNNER_HINT_END}\r\nGOAT_ARCHIVE_VERSION='1.2.4'\r\n`,
        // A declaration after the end line still counts, as a whole-file read sees it.
        afterEnd: `GOAT_NODE_SCRIPT_PATH=''\nGOAT_ARCHIVE_VERSION='1.2.3'\n${RUNNER_HINT_END}\nGOAT_NODE_SCRIPT_PATH='/x'\nGOAT_ARCHIVE_VERSION='9.9.9'\n`,
        afterEndLegacy: `T3_ARCHIVE_VERSION='1.2.3'\n${RUNNER_HINT_END}\nx\nT3_NODE_SCRIPT_PATH='/x'`,
        endFirst: `${RUNNER_HINT_END}\nGOAT_ARCHIVE_VERSION='1.2.3'\n`,
        endInLine: `GOAT_ARCHIVE_VERSION='1.2.3'${RUNNER_HINT_END}\n${RUNNER_HINT_END}\nGOAT_NODE_SCRIPT_PATH=''\n`,
        withNul: `GOAT_ARCHIVE_VERSION='1.2.3'\n${RUNNER_HINT_END}\n\u0000\nGOAT_ARCHIVE_VERSION='1.2.4'\n`,
      };
      for (const runner of Object.values(built))
        assert.include(runner.split("\n").slice(0, 8), RUNNER_HINT_END);
      for (const [name, text] of Object.entries(files))
        NodeFS.writeFileSync(NodePath.join(dir, name), text);
      const paths = [...Object.keys(files), "missing"].map((name) =>
        quote(NodePath.join(dir, name)),
      );
      const oldHint =
        'old_hint() { if grep -q "^$2=" "$1"; then k="$2"; else k="$3"; fi; sed -n "s/^$k=\'\\(.*\\)\'$/\\1/p" "$1"; }';
      const body = [
        oldHint,
        'same() { if [ "$2" = "$3" ]; then echo "$1 ok"; else printf "%s DIFF old=[%s] new=[%s]\\n" "$1" "$2" "$3"; fi; }',
        "for f in " + paths.join(" ") + "; do",
        '  same hint "$(old_hint "$f" GOAT_ARCHIVE_VERSION T3_ARCHIVE_VERSION 2>/dev/null || :)" "$(read_runner_hint "$f" GOAT_ARCHIVE_VERSION T3_ARCHIVE_VERSION 2>/dev/null || :)"',
        '  same hint-node "$(old_hint "$f" GOAT_NODE_SCRIPT_PATH T3_NODE_SCRIPT_PATH 2>/dev/null || :)" "$(read_runner_hint "$f" GOAT_NODE_SCRIPT_PATH T3_NODE_SCRIPT_PATH 2>/dev/null || :)"',
        '  same hint-same-key "$(old_hint "$f" T3_ARCHIVE_VERSION T3_ARCHIVE_VERSION 2>/dev/null || :)" "$(read_runner_hint "$f" T3_ARCHIVE_VERSION T3_ARCHIVE_VERSION 2>/dev/null || :)"',
        // Both declarations an exec key reads, as the old reader saw them.
        '  old_node="$(old_hint "$f" GOAT_NODE_SCRIPT_PATH T3_NODE_SCRIPT_PATH 2>/dev/null || :)"',
        '  old_version="$(old_hint "$f" GOAT_ARCHIVE_VERSION T3_ARCHIVE_VERSION 2>/dev/null || :)"',
        '  runner_key_hints "$f"',
        '  same node "$' +
          '{old_node:+1}" "$RUNNER_NODE_DECLARED"; same version "$old_version" "$RUNNER_ARCHIVE_VERSION"',
        '  fact_slurp "$f" || :; same cat "$(cat "$f" 2>/dev/null || true)" "$FACT_TEXT"',
        '  for want in 123 "" 1.2.3; do',
        '    if [ "$(cat "$f" 2>/dev/null || true)" = "$want" ]; then old_is=yes; else old_is=no; fi',
        '    if fact_file_is "$f" "$want"; then new_is=yes; else new_is=no; fi; same file_is "$old_is" "$new_is"',
        "  done",
        '  if [ -f "$f" ]; then',
        '    old_record="$(tr \'\\n\' \' \' <"$f")"; fact_read_record "$f"',
        '    same record "$old_record" "$FACT_TEXT"',
        "    for name in pid port; do",
        '      old_value="$(printf \'%s\\n\' "$old_record" | sed -n "s/.*\\"$name\\"[[:space:]]*:[[:space:]]*\\\\([0-9][0-9]*\\\\).*/\\\\1/p")"',
        '      fact_json_uint "\\"$name\\"" "$old_record"; same json "$old_value" "$FACT_TEXT"',
        "    done",
        "  fi",
        "done",
      ].join("\n");
      const verdicts = runIn(shell, body).trim().split("\n");
      assert.isAbove(verdicts.length, 40);
      assert.deepEqual(
        verdicts.filter((line) => !line.endsWith(" ok")),
        [],
      );
      // What stat and the digest tools print passes the same checks as the old regular expressions.
      const bin = NodePath.join(dir, "bin");
      NodeFS.mkdirSync(bin);
      for (const name of ["stat", "shasum", "sha256sum"])
        NodeFS.writeFileSync(
          NodePath.join(bin, name),
          '#!/bin/sh\nprintf "%s\\n" "$GOAT_TEST_OUT"\n',
          {
            mode: 0o755,
          },
        );
      const oldChecks = [
        'old_sig() { v="$(stat -f \'%d:%i:%z:%m:%c\' "$1" 2>/dev/null)" || v="$(stat -c \'%d:%i:%s:%Y:%Z\' "$1" 2>/dev/null)" || return 1',
        "  printf '%s\\n' \"$v\" | LC_ALL=C grep -Eq '^[0-9]+(:[0-9]+){4}$' || return 1; printf '%s' \"$v\"; }",
        'old_digest() { d="$(sha256sum "$1")" || return 1; d="$' + '{d%% *}"',
        "  printf '%s\\n' \"$d\" | LC_ALL=C grep -Eq '^[0-9a-f]{64}$' || return 1; printf '%s' \"$d\"; }",
      ].join("\n");
      const outputs = [
        "1:2:3:4:5",
        "10:2:3:4:5:6",
        "1:2:3:4",
        ":2:3:4:5",
        "1::3:4:5",
        "1:2:3:4:",
        "1:2:3:4:5x",
        "a:2:3:4:5",
        "",
        "a".repeat(64) + "  -",
        "A".repeat(64) + "  -",
        "a".repeat(63) + "  -",
        "a".repeat(65),
        "g" + "a".repeat(63),
        "\\" + "a".repeat(64) + "  -",
      ];
      const target = quote(NodePath.join(dir, "empty"));
      for (const output of outputs) {
        const out = runIn(
          shell,
          oldChecks +
            "\nfor check in sig digest; do" +
            "\n  old=FAIL; new=FAIL" +
            '\n  if [ $check = sig ]; then o="$(old_sig ' +
            target +
            ')" && old="$o"; n="$(file_sig ' +
            target +
            ')" && new="$n"' +
            '\n  else o="$(old_digest ' +
            target +
            ')" && old="$o"; n="$(runner_sha256 ' +
            target +
            ')" && new="$n"; fi' +
            '\n  printf \'%s|%s|%s\\n\' "$check" "$old" "$new"' +
            "\ndone",
          { PATH: bin + ":" + (process.env.PATH ?? ""), GOAT_TEST_OUT: output },
        );
        for (const line of out.trim().split("\n")) {
          const [check, oldValue, newValue] = line.split("|");
          assert.equal(newValue, oldValue, check + " for " + JSON.stringify(output));
        }
      }
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("reads a built runner in one call and parses only the lines before its end line", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-hint-reads-"));
    try {
      const runner = NodePath.join(dir, "run-t3.sh");
      const built = buildRemoteGoatRunnerScript({ archiveVersion: "1.2.3" });
      NodeFS.writeFileSync(runner, built);
      const trace = NodePath.join(dir, "trace");
      // bash traces every builtin, so the trace counts the reads and parsed lines of one exec key.
      const out = runIn(
        "bash",
        [
          `exec 9>${quote(trace)}; BASH_XTRACEFD=9; PS4='+ '; set -x`,
          `runner_key_hints ${quote(runner)}`,
          "set +x",
          'printf "%s|%s" "$RUNNER_NODE_DECLARED" "$RUNNER_ARCHIVE_VERSION"',
        ].join("\n"),
      );
      assert.equal(out, "|1.2.3");
      const steps = NodeFS.readFileSync(trace, "utf8").split("\n");
      const reads = steps.filter((line) => /^\++ (IFS= )?read /.test(line)).length;
      const parsed = steps.filter((line) => /^\++ hint_take /.test(line)).length;
      assert.isAbove(built.split("\n").length, 300);
      assert.equal(reads, 1);
      // Shebang, set -eu, four declarations and a comment come before the end line.
      assert.equal(parsed, 7);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
  it.each(["dash", "bash"])("remember exec keys only until a write they must see (%s)", (shell) => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-fact-memo-"));
    try {
      const versions = NodePath.join(dir, ".goat/runtime/goat/versions/1.2.3");
      NodeFS.mkdirSync(versions, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(versions, "goat"), "#!/bin/sh\n", { mode: 0o755 });
      NodeFS.writeFileSync(NodePath.join(versions, ".install-complete"), "1.2.3\n");
      NodeFS.writeFileSync(NodePath.join(dir, "a"), "GOAT_ARCHIVE_VERSION='1.2.3'\n# a\n");
      NodeFS.writeFileSync(NodePath.join(dir, "b"), "GOAT_ARCHIVE_VERSION='1.2.3'\n# bb\n");
      const bin = NodePath.join(dir, "bin");
      NodeFS.mkdirSync(bin);
      // Executables younger than 2 s are never keyed; this clock is far ahead of them.
      NodeFS.writeFileSync(NodePath.join(bin, "date"), "#!/bin/sh\necho 4102444800\n", {
        mode: 0o755,
      });
      for (const name of ["shasum", "sha256sum"])
        NodeFS.writeFileSync(
          NodePath.join(bin, name),
          '#!/bin/sh\necho digest >> "$HOME/digests"\nPATH="$' +
            '{PATH#*:}" exec ' +
            name +
            ' "$@"\n',
          { mode: 0o755 },
        );
      const key = 'exec_fact_key "$RUNNER_CANDIDATE_FILE.pin" && printf "%s\\n" "$FACT_KEY"';
      const out = runIn(
        shell,
        [
          'RUNNER_CANDIDATE_FILE="$HOME/next"; FACT_MEMO="$HOME/next.facts"; fact_memo_drop',
          'digests() { cat "$HOME/digests" 2>/dev/null | wc -l | tr -d " "; }',
          'pin_runner "$HOME/a"',
          'first="$(' + key + ')"; after_first="$(digests)"',
          // A later subshell reads the pinned runner's key without hashing it again.
          'again="$(' + key + ')"; after_again="$(digests)"',
          'pin_runner "$HOME/b"',
          'rewritten="$(' + key + ')"',
          // A write that bypasses pin_runner is seen through the runner's own signature.
          'cp "$HOME/a" "$HOME/next.pin"',
          'overwritten="$(' + key + ')"',
          // A reinstalled executable is seen through a remembered key.
          'printf "#!/bin/sh\\n# reinstalled\\n" > "$HOME/.goat/runtime/goat/versions/1.2.3/goat"',
          'reinstalled="$(' + key + ')"',
          'printf "%s\\n" "$first" "$again" "$rewritten" "$overwritten" "$reinstalled" "$after_first" "$after_again"',
          // A memo that cannot be emptied is not used again.
          'FACT_MEMO="$HOME"; pin_runner "$HOME/a"; printf "memo=%s\\n" "$FACT_MEMO"',
        ].join("\n"),
        { HOME: dir, PATH: bin + ":" + (process.env.PATH ?? "") },
      );
      const [first, again, rewritten, overwritten, reinstalled, afterFirst, afterAgain, memoLine] =
        out.trim().split("\n");
      assert.include(first, "versions/1.2.3/goat ");
      assert.equal(again, first);
      assert.equal(afterAgain, afterFirst);
      assert.notEqual(rewritten, first);
      assert.equal(overwritten, first);
      assert.notEqual(reinstalled, overwritten);
      assert.equal(memoLine, "memo=");
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});

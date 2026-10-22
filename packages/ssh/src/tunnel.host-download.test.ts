import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { ChildProcessSpawner } from "effect/process";

import { REMOTE_RUNTIME_STATE_KEY } from "./command.ts";
import * as SshTunnel from "./tunnel.ts";
import { ARCHIVE, arch, platform, uploadTarget } from "./tunnel.fixture.ts";
import { makeProtocolFixture } from "./tunnel.protocol.fixture.ts";

const stem = `goat-${ARCHIVE.archiveVersion}-${platform}-${arch}`;

/**
 * A fake curl on the host's PATH stands in for the release server: it serves the
 * fixture archive and its checksum, fails like a host without a route, or serves a
 * checksum that does not match.
 */
const fakeCurl = (cache: string, log: string, mode: string) => `#!/bin/sh
url=""; out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
printf '%s\\n' "$(basename "$url")" >> '${log}'
mode='${mode}'
if [ "$mode" = offline ]; then exit 6; fi
case "$url" in
  */SHA256SUMS)
    if [ "$mode" = corrupt ]; then printf '%s  %s\\n' "$(printf 'f%.0s' $(seq 64))" '${stem}.tar.gz' > "$out"
    else cp '${cache}/${stem}.tar.gz.sha256' "$out"; fi ;;
  *) cp '${cache}/${stem}.tar.gz' "$out" ;;
esac
`;

const fakeWget = (
  cache: string,
  log: string,
  flagsLog: string,
  mode: "modern" | "legacy",
) => `#!/bin/sh
mode='${mode}'
if [ "$1" = --help ]; then
  printf 'GNU Wget 1.%s\\n  -q,  --quiet\\n       --timeout=SECONDS\\n  -t,  --tries=NUMBER\\n       --waitretry=SECONDS\\n  -O,  --output-document=FILE\\n' "$([ "$mode" = modern ] && echo 21.4 || echo 18)"
  if [ "$mode" = modern ]; then
    printf '       --retry-on-http-error=ERRORS\\n'
  fi
  exit 0
fi
printf "%s\\n" "$*" >> '${flagsLog}'
url=""; out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -q|--timeout=*|--tries=*|--waitretry=*) shift ;;
    --retry-on-http-error=*)
      if [ "$mode" != modern ]; then
        printf "wget: unrecognized option '%s'\\n" "$1" >&2
        exit 2
      fi
      shift ;;
    -O) out="$2"; shift 2 ;;
    http*) url="$1"; shift ;;
    *) printf "wget: unrecognized option '%s'\\n" "$1" >&2; exit 2 ;;
  esac
done
printf '%s\\n' "$(basename "$url")" >> '${log}'
case "$url" in
  */SHA256SUMS) cp '${cache}/${stem}.tar.gz.sha256' "$out" ;;
  *) cp '${cache}/${stem}.tar.gz' "$out" ;;
esac
`;

const populatePathWithoutFetchTools = (fs: FileSystem.FileSystem, targetDir: string) =>
  Effect.gen(function* () {
    yield* fs.makeDirectory(targetDir, { recursive: true });
    const seen = new Set<string>(["curl", "wget"]);
    for (const dir of (process.env.PATH ?? "").split(":")) {
      if (!dir) continue;
      const entries = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
      for (const entry of entries) {
        if (seen.has(entry)) continue;
        seen.add(entry);
        yield* fs.symlink(`${dir}/${entry}`, `${targetDir}/${entry}`).pipe(Effect.ignore);
      }
    }
  });

const prepare = (mode: string | null) =>
  Effect.gen(function* () {
    const f = yield* makeProtocolFixture({
      live: false,
      kind: "managed",
      oldVersion: "1.2.2",
      ssh: SSH_RUNTIME_PROTOCOL_VERSION,
      orchestration: ORCHESTRATION_PROTOCOL_VERSION,
    });
    const bin = `${f.home}/.test/fake-curl`;
    const log = `${f.test}/curl-calls`;
    yield* f.fs.makeDirectory(bin, { recursive: true });
    yield* f.fs.writeFileString(
      `${bin}/curl`,
      fakeCurl(f.runner.archiveDirectory, log, mode ?? "serve"),
    );
    yield* f.fs.chmod(`${bin}/curl`, 0o755);
    yield* f.fs.writeFileString(log, "");
    f.setRemotePath(`${bin}:${f.home}/.test/identity-bin:${process.env.PATH ?? ""}`);
    const progress: SshTunnel.SshRuntimeProgress[] = [];
    const selected = yield* SshTunnel.prepareRemoteRuntime(
      uploadTarget,
      {},
      { ...f.runner, ...(mode === null ? {} : { hostDownload: true }) },
      REMOTE_RUNTIME_STATE_KEY,
      true,
      (step) => progress.push(step),
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, f.transport));
    const record = yield* f.fs.readFileString(
      `${f.home}/.goat/runtime/goat/versions/${ARCHIVE.archiveVersion}/.install-record`,
    );
    const fetched = (yield* f.fs.readFileString(log)).split("\n").filter(Boolean);
    return {
      selected,
      progress,
      source: record.trim().split(" ")[3],
      fetched,
      uploads: f.counters().uploads,
    };
  });

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("SSH host download", () => {
  it.live("installs a published release from the host's own network without uploading", () =>
    Effect.gen(function* () {
      const result = yield* prepare("serve");
      assert.equal(result.selected.version, ARCHIVE.archiveVersion);
      assert.isTrue(result.selected.uploaded);
      assert.equal(result.source, "https");
      assert.equal(result.uploads, 0);
      assert.isNotEmpty(result.progress);
      assert.isTrue(result.progress.every((step) => step.upload === undefined));
      assert.deepEqual(result.fetched, ["SHA256SUMS", `${stem}.tar.gz`]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live.each(["offline", "corrupt"])(
    "uploads the client's archive when the host download is %s",
    (mode) =>
      Effect.gen(function* () {
        const result = yield* prepare(mode);
        assert.equal(result.selected.version, ARCHIVE.archiveVersion);
        assert.equal(result.source, "cache");
        assert.equal(result.uploads, 1);
        const uploads = result.progress.flatMap((step) => step.upload ?? []);
        assert.isAtLeast(uploads.length, 2);
        assert.equal(uploads[0]?.sentBytes, 0);
        assert.equal(uploads.at(-1)?.sentBytes, uploads.at(-1)?.totalBytes);
        assert.isUndefined(result.progress[0]?.upload);
        assert.isAtLeast(result.fetched.length, 1);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("leaves acquisition to the client unless the runner opts in", () =>
    Effect.gen(function* () {
      const result = yield* prepare(null);
      assert.equal(result.source, "cache");
      assert.equal(result.uploads, 1);
      assert.deepEqual(result.fetched, []);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live(
    "uses wget on a wget-only host across modern and legacy GNU wget and falls back to upload when neither curl nor wget is present",
    () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: false,
          kind: "managed",
          oldVersion: "1.2.2",
          ssh: SSH_RUNTIME_PROTOCOL_VERSION,
          orchestration: ORCHESTRATION_PROTOCOL_VERSION,
        });
        const noFetchBin = `${f.home}/.test/no-fetch-bin`;
        yield* populatePathWithoutFetchTools(f.fs, noFetchBin);
        const wgetBin = `${f.home}/.test/wget-only-bin`;
        const log = `${f.test}/wget-calls`;
        const flagsLog = `${f.test}/wget-flags`;
        yield* f.fs.makeDirectory(wgetBin, { recursive: true });
        yield* f.fs.writeFileString(
          `${wgetBin}/wget`,
          fakeWget(f.runner.archiveDirectory, log, flagsLog, "modern"),
        );
        yield* f.fs.chmod(`${wgetBin}/wget`, 0o755);
        yield* f.fs.writeFileString(log, "");
        yield* f.fs.writeFileString(flagsLog, "");
        f.setRemotePath(`${wgetBin}:${f.home}/.test/identity-bin:${noFetchBin}`);

        const wgetResult = yield* SshTunnel.prepareRemoteRuntime(
          uploadTarget,
          {},
          { ...f.runner, hostDownload: true },
          REMOTE_RUNTIME_STATE_KEY,
          true,
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, f.transport));
        const wgetRecord = yield* f.fs.readFileString(
          `${f.home}/.goat/runtime/goat/versions/${ARCHIVE.archiveVersion}/.install-record`,
        );
        const wgetFetched = (yield* f.fs.readFileString(log)).split("\n").filter(Boolean);
        const wgetFlags = (yield* f.fs.readFileString(flagsLog)).split("\n").filter(Boolean);
        assert.equal(wgetResult.version, ARCHIVE.archiveVersion);
        assert.isTrue(wgetResult.uploaded);
        assert.equal(wgetRecord.trim().split(" ")[3], "https");
        assert.equal(f.counters().uploads, 0);
        assert.deepEqual(wgetFetched, ["SHA256SUMS", `${stem}.tar.gz`]);
        assert.lengthOf(wgetFlags, 2);
        for (const line of wgetFlags) {
          assert.include(line, "--tries=3");
          assert.include(line, "--waitretry=2");
          assert.include(line, "--retry-on-http-error=408,429,500,502,503,504");
        }

        // Reinstall against legacy GNU wget (< 1.19.1) that rejects --retry-on-http-error.
        yield* f.fs.remove(`${f.home}/.goat/runtime/goat/versions/${ARCHIVE.archiveVersion}`, {
          recursive: true,
        });
        yield* f.fs.writeFileString(
          `${wgetBin}/wget`,
          fakeWget(f.runner.archiveDirectory, log, flagsLog, "legacy"),
        );
        yield* f.fs.chmod(`${wgetBin}/wget`, 0o755);
        yield* f.fs.writeFileString(log, "");
        yield* f.fs.writeFileString(flagsLog, "");

        const legacyResult = yield* SshTunnel.prepareRemoteRuntime(
          uploadTarget,
          {},
          { ...f.runner, hostDownload: true },
          REMOTE_RUNTIME_STATE_KEY,
          true,
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, f.transport));
        const legacyRecord = yield* f.fs.readFileString(
          `${f.home}/.goat/runtime/goat/versions/${ARCHIVE.archiveVersion}/.install-record`,
        );
        const legacyFetched = (yield* f.fs.readFileString(log)).split("\n").filter(Boolean);
        const legacyFlags = (yield* f.fs.readFileString(flagsLog)).split("\n").filter(Boolean);
        assert.equal(legacyResult.version, ARCHIVE.archiveVersion);
        assert.isTrue(legacyResult.uploaded);
        assert.equal(legacyRecord.trim().split(" ")[3], "https");
        assert.equal(f.counters().uploads, 0);
        assert.deepEqual(legacyFetched, ["SHA256SUMS", `${stem}.tar.gz`]);
        assert.lengthOf(legacyFlags, 2);
        for (const line of legacyFlags) {
          assert.include(line, "--tries=3");
          assert.include(line, "--waitretry=2");
          assert.notInclude(line, "--retry-on-http-error");
        }

        // Remove the installed version and wget so neither curl nor wget is on the login PATH.
        yield* f.fs.remove(`${f.home}/.goat/runtime/goat/versions/${ARCHIVE.archiveVersion}`, {
          recursive: true,
        });
        f.setRemotePath(`${f.home}/.test/identity-bin:${noFetchBin}`);
        const fallbackResult = yield* SshTunnel.prepareRemoteRuntime(
          uploadTarget,
          {},
          { ...f.runner, hostDownload: true },
          REMOTE_RUNTIME_STATE_KEY,
          true,
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, f.transport));
        const fallbackRecord = yield* f.fs.readFileString(
          `${f.home}/.goat/runtime/goat/versions/${ARCHIVE.archiveVersion}/.install-record`,
        );
        assert.equal(fallbackResult.version, ARCHIVE.archiveVersion);
        assert.equal(fallbackRecord.trim().split(" ")[3], "cache");
        assert.equal(f.counters().uploads, 1);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

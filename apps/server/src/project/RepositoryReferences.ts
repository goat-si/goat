import {
  REFERENCE_FILE_BYTES,
  REFERENCE_SNAPSHOT_BYTES,
  RepositoryReferenceSource,
  type RepositoryReferenceSnapshot,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ProcessRunner from "../processRunner.ts";
import * as Inventory from "./RepositoryInventory.ts";

export class RepositoryReferenceError extends Schema.TaggedError<RepositoryReferenceError>()(
  "RepositoryReferenceError",
  {
    reason: Schema.Literals([
      "invalid_scope",
      "not_registered",
      "ambiguous_checkout",
      "source_unavailable",
      "source_changed",
      "revision_missing",
      "path_denied",
      "not_regular_file",
      "content_limit",
      "credential_content",
      "unsupported_repository",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Repository snapshot refused: ${this.reason}. No source permissions or files were changed.`;
  }
}

const decodeSource = Schema.decodeUnknownEffect(RepositoryReferenceSource, {
  onExcessProperty: "error",
});
const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const secretSegment =
  /^(?:\.env(?:\..*)?|\.git|\.ssh|\.aws|\.azure|\.kube|\.config|\.codex|\.claude|\.goat|\.t3|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|ed25519|dsa|ecdsa).*|.*\.(?:pem|key|p12|pfx|keystore)|(?:credentials?|secrets?|auth|tokens?)(?:\..*)?|.*service[-_]account.*)$/i;
const secretContent =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{12,}|sk-[A-Za-z0-9_-]{20,})\b/i;

function hasSecretAssignment(text: string): boolean {
  // Match the whole assignment identifier, then its terminal key words. Prefixes such as
  // DB_/AWS_ and camelCase qualify; passwordLabel/tokenCount are ordinary identifiers.
  for (const match of text.matchAll(
    /(?:^|[^\w$.-])["']?([A-Za-z_$][\w$.-]*)["']?\s*[:=](?!=|>)/g,
  )) {
    const key = match[1]!
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/[.$-]+/g, "_")
      .toLowerCase();
    if (
      /(?:^|_)(?:password|passwd|api_?key|(?:api|auth|access|refresh)_?token|client_?secret|private_?key|secret_?access_?key|secret|credentials?|token|authorization)$/.test(
        key,
      )
    )
      return true;
  }
  return false;
}

/** Shared by local captures and validation of untrusted remote snapshot responses. */
export const referenceContentAllowed = (path: string, text: string) =>
  !path.split("/").some((part) => secretSegment.test(part)) &&
  !text.includes("\0") &&
  !/[a-z][a-z0-9+.-]*:\/\/[^\s/:]+:[^\s/@]+@|authorization\s*:\s*(?:bearer|basic)\s+\S+/i.test(
    text,
  ) &&
  !hasSecretAssignment(text) &&
  !secretContent.test(text);

export class RepositoryReferences extends Context.Service<
  RepositoryReferences,
  {
    readonly capture: (
      source: unknown,
    ) => Effect.Effect<RepositoryReferenceSnapshot, RepositoryReferenceError>;
  }
>()("goat/project/RepositoryReferences") {}

const make = Effect.gen(function* () {
  const inventory = yield* Inventory.RepositoryInventory;
  const runner = yield* ProcessRunner.ProcessRunner;
  const lock = yield* Semaphore.make(1);
  const git = Effect.fn("RepositoryReferences.git")(function* (
    cwd: string,
    args: ReadonlyArray<string>,
    limit = 8192,
  ) {
    return yield* runner
      .run({
        command: "git",
        args: [
          "--no-optional-locks",
          "--no-replace-objects",
          "-c",
          "safe.bareRepository=explicit",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "protocol.allow=never",
          "-C",
          cwd,
          ...args,
        ],
        env: {
          GIT_NO_LAZY_FETCH: "1",
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_DIR: undefined,
          GIT_WORK_TREE: undefined,
          GIT_INDEX_FILE: undefined,
          GIT_OBJECT_DIRECTORY: undefined,
          GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
          GIT_CONFIG_COUNT: "0",
          GIT_CONFIG_PARAMETERS: "",
        },
        timeout: 1000,
        maxOutputBytes: limit,
      })
      .pipe(
        Effect.mapError(
          (cause) => new RepositoryReferenceError({ reason: "source_unavailable", cause }),
        ),
      );
  });
  const capture = Effect.fn("RepositoryReferences.capture")(
    function* (raw: unknown) {
      const source = yield* decodeSource(raw).pipe(
        Effect.mapError(
          (cause) => new RepositoryReferenceError({ reason: "invalid_scope", cause }),
        ),
      );
      const files = [...new Set(source.files)];
      if (files.some((file) => !referenceContentAllowed(file, "")))
        return yield* new RepositoryReferenceError({ reason: "path_denied" });
      const known = yield* inventory.readFresh;
      if (known.truncated && source.checkout === undefined)
        return yield* new RepositoryReferenceError({ reason: "ambiguous_checkout" });
      const matches = known.entries.filter(
        (entry) =>
          entry.state === "available" &&
          entry.originKey === source.repositoryKey &&
          (source.checkout === undefined || entry.path === source.checkout),
      );
      if (matches.length === 0)
        return yield* new RepositoryReferenceError({
          reason: known.truncated ? "source_unavailable" : "not_registered",
        });
      if (matches.length !== 1)
        return yield* new RepositoryReferenceError({ reason: "ambiguous_checkout" });
      const cwd = matches[0]!.path;
      const origin = Effect.fn("RepositoryReferences.origin")(function* () {
        const result = yield* git(cwd, [
          "config",
          "--local",
          "--no-includes",
          "--get",
          "remote.origin.url",
        ]);
        if (
          result.code !== 0 ||
          Inventory.repositoryOriginKey(result.stdout) !== source.repositoryKey
        )
          return yield* new RepositoryReferenceError({ reason: "source_changed" });
      });
      yield* origin();
      // A promisor may fetch missing objects during cat-file. Refuse partial clones entirely,
      // in addition to GIT_NO_LAZY_FETCH, so older Git cannot invoke a credential-bearing helper.
      const partial = yield* git(cwd, [
        "config",
        "--name-only",
        "--get-regexp",
        "^(extensions\\.partialclone|remote\\..*\\.promisor)$",
      ]);
      if (partial.code !== 1)
        return yield* new RepositoryReferenceError({ reason: "unsupported_repository" });
      const resolved = yield* git(cwd, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${source.revision ?? "HEAD"}^{commit}`,
      ]);
      const revision = resolved.stdout.trim();
      if (resolved.code !== 0 || !oid.test(revision))
        return yield* new RepositoryReferenceError({ reason: "revision_missing" });
      const captured: Array<RepositoryReferenceSnapshot["files"][number]> = [];
      let totalBytes = 0;
      for (const file of files) {
        const tree = yield* git(cwd, [
          "ls-tree",
          "--full-tree",
          "-z",
          revision,
          "--",
          `:(literal)${file}`,
        ]);
        const records = tree.stdout.split("\0").filter(Boolean);
        const entry =
          records.length === 1
            ? /^(100644|100755) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(records[0]!)
            : null;
        if (tree.code !== 0 || entry === null || entry[3] !== file || !oid.test(entry[2]!))
          return yield* new RepositoryReferenceError({ reason: "not_regular_file" });
        const blob = entry[2]!;
        const size = yield* git(cwd, ["cat-file", "-s", blob]);
        const bytes = Number(size.stdout.trim());
        if (
          size.code !== 0 ||
          !Number.isSafeInteger(bytes) ||
          bytes < 0 ||
          bytes > REFERENCE_FILE_BYTES ||
          totalBytes + bytes > REFERENCE_SNAPSHOT_BYTES
        )
          return yield* new RepositoryReferenceError({ reason: "content_limit" });
        const contents = yield* git(cwd, ["cat-file", "blob", blob], REFERENCE_FILE_BYTES);
        if (
          contents.code !== 0 ||
          contents.stdoutInvalidUtf8 ||
          contents.stdoutTruncated ||
          new TextEncoder().encode(contents.stdout).length !== bytes
        )
          return yield* new RepositoryReferenceError({ reason: "content_limit" });
        if (!referenceContentAllowed(file, contents.stdout))
          return yield* new RepositoryReferenceError({ reason: "credential_content" });
        captured.push({ path: file, blob, text: contents.stdout });
        totalBytes += bytes;
      }
      yield* origin();
      if (source.revision === undefined) {
        const current = yield* git(cwd, ["rev-parse", "--verify", "HEAD"]);
        if (current.code !== 0 || current.stdout.trim() !== revision)
          return yield* new RepositoryReferenceError({ reason: "source_changed" });
      }
      return {
        repositoryKey: source.repositoryKey,
        revision,
        files: captured,
        totalBytes,
        uncommittedChangesExcluded: true,
      } satisfies RepositoryReferenceSnapshot;
    },
    lock.withPermits(1),
    Effect.timeoutOrElse({
      duration: 15000,
      orElse: () => Effect.fail(new RepositoryReferenceError({ reason: "source_unavailable" })),
    }),
  );
  return RepositoryReferences.of({ capture });
});
export const layer = Layer.effect(RepositoryReferences, make);

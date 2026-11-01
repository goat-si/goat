import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Inventory from "./RepositoryInventory.ts";
import * as References from "./RepositoryReferences.ts";
import { referenceFixture, referenceTestLayer } from "./RepositoryReferences.testkit.ts";
import {
  prefixedSecretAssignments,
  ordinaryReferenceCode,
} from "./referenceSecretFixtures.testkit.ts";

it.effect(
  "rejects complete prefixed credential assignment keys in Git blobs without blocking ordinary identifiers",
  () =>
    Effect.gen(function* () {
      const f = yield* referenceFixture;
      for (const [index, text] of prefixedSecretAssignments.entries())
        yield* f.fs.writeFileString(f.repo + `/settings-${index}.txt`, text);
      yield* f.fs.writeFileString(f.repo + "/ordinary.ts", ordinaryReferenceCode);
      yield* f.git(["add", "."]);
      yield* f.git(["commit", "-m", "synthetic prefixed key fixtures"]);
      const before = yield* f.state;
      for (const [index] of prefixedSecretAssignments.entries()) {
        const error = yield* f
          .capture({ ...f.source, files: ["source.ts", `settings-${index}.txt`] })
          .pipe(Effect.flip);
        expect(error.reason).toBe("credential_content");
        expect(error.message).not.toContain("fixture-only-value");
        expect(error.message).not.toContain("export const result");
      }
      expect((yield* f.capture({ ...f.source, files: ["ordinary.ts"] })).files[0]?.text).toBe(
        ordinaryReferenceCode,
      );
      expect(yield* f.state).toEqual(before);
    }).pipe(Effect.scoped, Effect.provide(referenceTestLayer)),
);

it.effect(
  "reads unpushed committed content, excludes dirty bytes and preserves source refs/config/index",
  () =>
    Effect.gen(function* () {
      const f = yield* referenceFixture;
      yield* f.fs.writeFileString(f.repo + "/source.ts", "export const result = 43;\n");
      yield* f.git(["add", "source.ts"]);
      yield* f.git(["commit", "-m", "unpushed"]);
      const head = yield* f.git(["rev-parse", "HEAD"]);
      yield* f.fs.writeFileString(f.repo + "/source.ts", "dirty working copy");
      const before = yield* f.state;
      const snapshot = yield* f.capture();
      expect(snapshot.revision).toBe(head);
      expect(snapshot.revision).not.toBe(f.base);
      expect(snapshot.files[0]?.text).toBe("export const result = 43;\n");
      expect(snapshot.uncommittedChangesExcluded).toBe(true);
      expect(snapshot.totalBytes).toBe(new TextEncoder().encode(snapshot.files[0]!.text).length);
      expect(yield* f.state).toEqual(before);
      expect(
        f.commands.some(
          (command) => command.args.includes("fetch") || command.args.includes("push"),
        ),
      ).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(referenceTestLayer)),
);

it.effect(
  "rejects write operations, unsupported root grants and traversal at the service boundary",
  () =>
    Effect.gen(function* () {
      const f = yield* referenceFixture;
      const before = yield* f.state;
      for (const request of [
        { ...f.source, operation: "write", content: "overwrite" },
        { ...f.source, mode: "read-only-root" },
        ...[
          "../outside.ts",
          "/absolute.ts",
          ".git/config",
          "dir/../../source.ts",
          "C:\\outside.ts",
          "source.ts\0other",
          "dir//source.ts",
        ].map((path) => ({ ...f.source, files: [path] })),
      ])
        expect((yield* f.capture(request).pipe(Effect.flip)).reason).toBe("invalid_scope");
      expect(f.commands).toEqual([]);
      expect(yield* f.state).toEqual(before);
    }).pipe(Effect.scoped, Effect.provide(referenceTestLayer)),
);

it.effect("rejects tracked symlinks, symlink descendants, directories and submodule entries", () =>
  Effect.gen(function* () {
    const f = yield* referenceFixture;
    const outside = f.root + "/outside";
    yield* f.fs.makeDirectory(outside);
    yield* f.fs.writeFileString(outside + "/private.txt", "must not escape");
    yield* f.fs.symlink(outside, f.repo + "/linked");
    yield* f.fs.symlink(outside + "/private.txt", f.repo + "/linked.txt");
    yield* f.fs.makeDirectory(f.repo + "/directory");
    yield* f.fs.writeFileString(f.repo + "/directory/file.ts", "ok");
    yield* f.git(["add", "."]);
    yield* f.git(["update-index", "--add", "--cacheinfo", `160000,${f.base},submodule`]);
    yield* f.git(["commit", "-m", "non-files"]);
    for (const file of ["linked", "linked/private.txt", "linked.txt", "directory", "submodule"]) {
      expect((yield* f.capture({ ...f.source, files: [file] }).pipe(Effect.flip)).reason).toBe(
        "not_regular_file",
      );
    }
    expect(yield* f.fs.readFileString(outside + "/private.txt")).toBe("must not escape");
  }).pipe(Effect.scoped, Effect.provide(referenceTestLayer)),
);

it.effect(
  "blocks credential paths, credential-bearing content, binary files and byte overflow",
  () =>
    Effect.gen(function* () {
      const f = yield* referenceFixture;
      yield* f.fs.writeFileString(f.repo + "/.env", "do not read");
      yield* f.fs.writeFileString(
        f.repo + "/config.ts",
        "const remote = 'https://user:password@example.test/repo';",
      );
      yield* f.fs.writeFileString(f.repo + "/key.txt", "-----BEGIN PRIVATE KEY-----\nfixture\n");
      yield* f.fs.writeFileString(f.repo + "/binary.txt", "before\0after");
      yield* f.fs.writeFileString(f.repo + "/settings.ini", "password = exampleSecret123\n");
      yield* f.fs.writeFileString(f.repo + "/settings.yaml", "api_key: exampleSecret123\n");
      yield* f.fs.writeFileString(f.repo + "/large.txt", "x".repeat(16 * 1024 + 1));
      yield* f.git(["add", "."]);
      yield* f.git(["commit", "-m", "denied content fixtures"]);
      expect((yield* f.capture({ ...f.source, files: [".env"] }).pipe(Effect.flip)).reason).toBe(
        "path_denied",
      );
      for (const file of ["config.ts", "key.txt", "binary.txt", "settings.ini", "settings.yaml"])
        expect((yield* f.capture({ ...f.source, files: [file] }).pipe(Effect.flip)).reason).toBe(
          "credential_content",
        );
      expect(
        (yield* f.capture({ ...f.source, files: ["large.txt"] }).pipe(Effect.flip)).reason,
      ).toBe("content_limit");
    }).pipe(Effect.scoped, Effect.provide(referenceTestLayer)),
);

it.effect("never infers a unique source from an incomplete inventory", () =>
  Effect.gen(function* () {
    const f = yield* referenceFixture;
    const layer = References.layer.pipe(
      Layer.provide(
        Layer.mock(Inventory.RepositoryInventory)({
          readFresh: Effect.succeed({
            sampledAt: 0,
            truncated: true,
            entries: [
              {
                path: f.repo,
                originKey: f.source.repositoryKey,
                state: "available",
                head: f.base,
                branch: "main",
                upstream: "origin/main",
                ahead: 0,
                behind: 0,
                dirty: false,
                dependencies: { state: "unknown", installedAt: null },
              },
            ],
          }),
        }),
      ),
    );
    yield* Effect.gen(function* () {
      const reader = yield* References.RepositoryReferences;
      expect((yield* reader.capture(f.source).pipe(Effect.flip)).reason).toBe("ambiguous_checkout");
      expect((yield* reader.capture({ ...f.source, checkout: f.repo })).files[0]?.text).toBe(
        "export const result = 42;\n",
      );
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped, Effect.provide(referenceTestLayer)),
);

it.effect(
  "pins exact local commits and rejects missing revisions, missing sources and removed registrations",
  () =>
    Effect.gen(function* () {
      const f = yield* referenceFixture;
      expect((yield* f.capture({ ...f.source, revision: f.base })).revision).toBe(f.base);
      expect(
        (yield* f.capture({ ...f.source, revision: "f".repeat(40) }).pipe(Effect.flip)).reason,
      ).toBe("revision_missing");
      expect((yield* f.capture({ ...f.source, checkout: f.root }).pipe(Effect.flip)).reason).toBe(
        "not_registered",
      );
      f.unregister();
      expect((yield* f.capture().pipe(Effect.flip)).reason).toBe("not_registered");
    }).pipe(Effect.scoped, Effect.provide(referenceTestLayer)),
);

it.effect(
  "requires checkout selection for duplicate origins and deduplicates explicitly requested files",
  () =>
    Effect.gen(function* () {
      const f = yield* referenceFixture;
      yield* f.git(["worktree", "add", "-b", "sibling", f.root + "/other"]);
      expect((yield* f.capture().pipe(Effect.flip)).reason).toBe("ambiguous_checkout");
      const snapshot = yield* f.capture({
        ...f.source,
        checkout: f.repo,
        files: ["source.ts", "source.ts"],
      });
      expect(snapshot.files).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(referenceTestLayer)),
);

it.effect(
  "refuses changed HEAD or origin during a read rather than returning mixed provenance",
  () =>
    Effect.gen(function* () {
      const f = yield* referenceFixture;
      let changed = false;
      f.intercept((input) => {
        if (changed || !input.args.includes("blob")) return Effect.void;
        changed = true;
        return f.git(["commit", "--allow-empty", "-m", "concurrent change"]).pipe(Effect.asVoid);
      });
      expect((yield* f.capture().pipe(Effect.flip)).reason).toBe("source_changed");
      f.intercept((input) =>
        input.args.includes("blob")
          ? f
              .git(["remote", "set-url", "origin", "https://invalid.example/other/repo.git"])
              .pipe(Effect.asVoid)
          : Effect.void,
      );
      expect((yield* f.capture({ ...f.source, revision: f.base }).pipe(Effect.flip)).reason).toBe(
        "source_changed",
      );
    }).pipe(Effect.scoped, Effect.provide(referenceTestLayer)),
);

it.effect("refuses promisor repositories before object reads and never invokes their remote", () =>
  Effect.gen(function* () {
    const f = yield* referenceFixture;
    yield* f.git(["config", "remote.origin.promisor", "true"]);
    const before = yield* f.state;
    expect((yield* f.capture().pipe(Effect.flip)).reason).toBe("unsupported_repository");
    expect(
      f.commands.some(
        (input) =>
          input.args.includes("cat-file") ||
          input.args.includes("fetch") ||
          input.args.includes("status") ||
          input.args.includes("rev-list"),
      ),
    ).toBe(false);
    expect(yield* f.state).toEqual(before);
  }).pipe(Effect.scoped, Effect.provide(referenceTestLayer)),
);

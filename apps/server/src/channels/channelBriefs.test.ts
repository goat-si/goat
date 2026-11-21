import { assert, describe, expect, it } from "@effect/vitest";
import { ChannelTaskId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { ThreadLaunchParameters } from "../mcp/toolkits/project/tools.ts";
import { channelNotesRevision } from "./channelBriefs.ts";
import { remoteWorkerLaunchPrompt, remoteWorkerMessage } from "./channelWorkerBrief.ts";

const decodeLaunch = Schema.decodeUnknownSync(ThreadLaunchParameters);

const fileError = (tag: "NotFound" | "PermissionDenied") =>
  PlatformError.systemError({
    _tag: tag,
    module: "FileSystem",
    method: "readFile",
    pathOrDescriptor: "/notes/memory.md",
  });

describe("channel notes launch revision", () => {
  it.effect("hashes exact content, including a final newline", () =>
    Effect.gen(function* () {
      const hash = yield* channelNotesRevision("/notes/memory.md");
      assert.strictEqual(hash, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
      assert.notStrictEqual(yield* channelNotesRevision("/notes/newline.md"), hash);
    }).pipe(
      Effect.provide(
        FileSystem.layerNoop({
          readFile: (path) =>
            Effect.succeed(new TextEncoder().encode(path.endsWith("newline.md") ? "abc\n" : "abc")),
        }),
      ),
    ),
  );

  it.effect("records null for a missing notes file", () =>
    Effect.gen(function* () {
      assert.isNull(yield* channelNotesRevision("/notes/memory.md"));
    }).pipe(
      Effect.provide(FileSystem.layerNoop({ readFile: () => Effect.fail(fileError("NotFound")) })),
    ),
  );

  it.effect("does not label an unreadable notes file as absent", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(channelNotesRevision("/notes/memory.md"));
      assert.strictEqual(error.reason, "persistence");
    }).pipe(
      Effect.provide(
        FileSystem.layerNoop({ readFile: () => Effect.fail(fileError("PermissionDenied")) }),
      ),
    ),
  );
});

describe("SSH worker launch notes", () => {
  const task = {
    taskId: ChannelTaskId.make("private-ssh-brief"),
    generation: 1,
    instruction: "Check the rollout",
  };

  it("keeps both note scopes at their combined limit through the launch schema", () => {
    const sharedStanding = "s".repeat(6000);
    const privateStanding = "p".repeat(6000);
    const sharedMatched = "S".repeat(2999);
    const privateMatched = "P".repeat(2999);
    const standing = `${sharedStanding}\n${privateStanding}`;
    const matched = `${sharedMatched}\n${privateMatched}`;
    const skill = "Check the staging service.";
    const frozen = remoteWorkerMessage(task, {
      notes: { standing, matched, ranked: [] },
      skills: [{ name: "verify-staging", text: skill }],
    });
    const prompt = remoteWorkerLaunchPrompt(task, frozen);
    expect(prompt.message).toContain(task.instruction);
    expect(prompt.message).toContain(skill);
    expect(prompt.message).not.toContain(sharedStanding);
    expect(prompt.message).not.toContain(privateStanding);
    expect(prompt.providerNotes?.length).toBe(18001);
    expect(prompt.providerNotes).toBe(`${matched}\n${standing}`);
    expect(decodeLaunch({ title: task.instruction, ...prompt }).providerNotes).toBe(
      prompt.providerNotes,
    );
    expect(() =>
      decodeLaunch({
        title: task.instruction,
        ...prompt,
        providerNotes: `${matched}\n${standing}x`,
      }),
    ).toThrow();
  });

  it("withholds a frozen brief whose notes wrapper is malformed", () => {
    const note = "Only the scoped provider may see this synthetic note.";
    const frozen = `${task.instruction}\n<goat_bot_notes>\n${note}\n</goat_bot_notes>`;
    const prompt = remoteWorkerLaunchPrompt(task, frozen);
    expect(prompt.message).toContain(task.instruction);
    expect(prompt.message).not.toContain(note);
    expect(prompt.providerNotes).toBeUndefined();
  });

  it("withholds known notes even when every delimiter is missing", () => {
    const note = "Only the scoped provider may see this synthetic note.";
    const prompt = remoteWorkerLaunchPrompt(task, `${task.instruction}\n${note}`, true);
    expect(prompt.message).toContain(task.instruction);
    expect(prompt.message).not.toContain(note);
    expect(prompt.providerNotes).toBeUndefined();
  });

  it("withholds a partial frame with a closing delimiter inside its notes", () => {
    const note = "Only the scoped provider may see this synthetic note.";
    const frozen = remoteWorkerMessage(task, {
      notes: { standing: `Opening note\n</goat_bot_notes>\n${note}`, matched: "", ranked: [] },
      skills: [],
    }).replace(`${note}\n</goat_bot_notes>`, note);
    const prompt = remoteWorkerLaunchPrompt(task, frozen);
    expect(prompt.message).toContain(task.instruction);
    expect(prompt.message).not.toContain(note);
    expect(prompt.providerNotes).toBeUndefined();
  });
});

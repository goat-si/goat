// @effect-diagnostics-next-line nodeBuiltinImport:off -- mkfifo has no Effect API.
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { BotId, ChannelTaskId, goatBotForgetNoteMessage, type ThreadId } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import { layerSessionStore } from "../auth/SessionEnd.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelBotMembers from "./ChannelBotMembers.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import type { ChannelIngressContext } from "./ChannelIngressContext.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import { DEFAULT_BOT_IDENTITY } from "./ChannelBotProfiles.ts";
import { NOTES_HEADER, parseChannelBotNoteLines, replacesMarker } from "./channelBotNoteLines.ts";
import {
  channelBotFilesFor,
  readChannelBotNotes,
  readChannelBotNotesSnapshot,
  recallChannelBotNotes,
} from "./channelBotNotes.ts";
import {
  EMPTY_NOTES,
  NOTES_SCAN_BYTES,
  NOTES_SECTION_CHARS,
  selectChannelBotNotes,
} from "./channelBotNotesRecall.ts";
import { frozenSessionPrefix, notesAreCurrent } from "./channelBotSessionBrief.ts";
import { sessionRotationReason, withIdentity } from "./channelBotSessionRotation.ts";
import {
  REMOTE_MESSAGE_CHARS,
  remoteWorkerMessage,
  turnInstruction,
} from "./channelWorkerBrief.ts";
import {
  EVAL_SET,
  evalNotesFile,
  scoreShown,
  type EvalKind,
  type EvalSet,
} from "./testkit/channelBotNotesEval.ts";
import { HELDOUT_SET } from "./testkit/channelBotNotesHeldout.ts";
import { dispatchBarrier } from "./testkit/dispatchRace.ts";
import {
  defaultScript,
  goatInput,
  linkSlackUser,
  makeHarness,
  memoryRpcContext,
  rpcContext,
  environmentId,
  owner,
  botThreadId,
  setupBot,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";

const task = (instruction: string) => ({
  taskId: ChannelTaskId.make("channel-task:1"),
  generation: 1,
  instruction,
});

const windowsHost = HostProcess.Platform.defaultValue() === "win32";

const notesFile = (text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const files = channelBotFilesFor(yield* Path.Path, yield* fs.makeTempDirectoryScoped());
    yield* fs.makeDirectory(files.dir, { recursive: true });
    yield* fs.writeFileString(files.notes, text);
    return files;
  });

const notesBlock = (message: string) =>
  /<goat_bot_notes>\n([\s\S]*?)\n<\/goat_bot_notes>/u.exec(message)?.[1] ?? "";

const line = (text: string, id: string, replaces?: string) =>
  "- 2026-03-01: " +
  text +
  " (asked in channel-input:" +
  id +
  ")" +
  (replaces === undefined ? "" : replacesMarker(replaces));

/** Filler notes that share no word with the tests below, `bytes` long. */
const filler = (bytes: number) => {
  const lines: Array<string> = [];
  let size = 0;
  for (let at = 0; size < bytes; at++) {
    const next = line("Water the office plants on shelf " + at + " before lunch.", "fill-" + at);
    lines.push(next);
    size += next.length + 1;
  }
  return lines;
};

// Paraphrases that share no word with their note are out of reach of a word search; these floors
// record what this selection reaches so a change cannot quietly lose them.
const PARAPHRASE_FLOOR = new Map<EvalSet, number>([
  [EVAL_SET, 4],
  [HELDOUT_SET, 1],
]);

const EVAL_CASES = [
  { name: "main", set: EVAL_SET, kilobytes: 64 },
  { name: "main", set: EVAL_SET, kilobytes: 200 },
  { name: "held-out", set: HELDOUT_SET, kilobytes: 64 },
  { name: "held-out", set: HELDOUT_SET, kilobytes: 200 },
];

describe("scoped note reads", () => {
  it.effect.each(["private", "shared"] as const)(
    "keeps the readable file when the %s scope fails",
    (broken) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const state = yield* fs.makeTempDirectoryScoped();
        const own = channelBotFilesFor(path, state, BotId.make("scout"));
        const shared = channelBotFilesFor(path, state);
        const [bad, good] = broken === "private" ? [own, shared] : [shared, own];
        const fact = line("The staging gate is Juniper.", "juniper");
        yield* fs.makeDirectory(bad.notes, { recursive: true });
        yield* fs.makeDirectory(good.dir, { recursive: true });
        yield* fs.writeFileString(good.notes, NOTES_HEADER + fact + "\n");
        const snapshot = yield* recallChannelBotNotes(own, "staging gate", true);
        assert.include(snapshot?.standing ?? "", fact);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("GOAT Bot notes beyond the newest 6,000 characters", () => {
  it.effect.each(EVAL_CASES)(
    "reception, session and remote briefs show every note that shares a word with the message ($name set, $kilobytes KB)",
    ({ set, kilobytes }) =>
      Effect.gen(function* () {
        const file = evalNotesFile(kilobytes * 1024, set);
        const files = yield* notesFile(file.text);
        const surfaces = ["reception", "session", "remote", "remote near the cap"] as const;
        const found = new Map<string, number>();
        const expected = new Map<string, number>();
        let leaked = 0;
        const count = (surface: string, kind: EvalKind, shown: string, index: number) => {
          const message = set.messages[index];
          if (message === undefined) return;
          const score = scoreShown(file, message, shown);
          const key = surface + "/" + kind;
          found.set(key, (found.get(key) ?? 0) + score.found);
          expected.set(key, (expected.get(key) ?? 0) + score.expected);
          leaked += score.leaked;
        };
        for (const [index, message] of set.messages.entries()) {
          const section = yield* readChannelBotNotes(files, message.text);
          assert.isAtMost(section.length, NOTES_SECTION_CHARS);
          count("reception", message.kind, section, index);

          const notes = (yield* readChannelBotNotesSnapshot(files, message.text)) ?? EMPTY_NOTES;
          const session = frozenSessionPrefix({
            standing: "",
            notes: notes.standing,
            journal: "",
            tail: [],
            openWork: [],
            message: turnInstruction(task(message.text), files, false, notes.matched),
          });
          count("session", message.kind, session, index);
          count(
            "remote",
            message.kind,
            notesBlock(remoteWorkerMessage(task(message.text), { notes, skills: [] })),
            index,
          );

          const long = "x".repeat(REMOTE_MESSAGE_CHARS - 3_000) + "\n" + message.text;
          const near = remoteWorkerMessage(task(long), {
            notes: yield* readChannelBotNotesSnapshot(files, long),
            skills: [],
          });
          assert.isAtMost(near.length, REMOTE_MESSAGE_CHARS);
          assert.isAtMost(notesBlock(near).length, 2_000);
          count("remote near the cap", message.kind, notesBlock(near), index);
        }
        assert.strictEqual(leaked, 0, "a replaced note was shown");
        for (const surface of surfaces) {
          for (const kind of ["exact", "korean", "correction", "multi", "distractor"] as const) {
            const key = surface + "/" + kind;
            assert.strictEqual(found.get(key) ?? 0, expected.get(key) ?? 0, key);
          }
          assert.isAtLeast(
            found.get(surface + "/paraphrase") ?? 0,
            PARAPHRASE_FLOOR.get(set) ?? 0,
            surface + "/paraphrase",
          );
        }
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a file whose notes in force fit 9,000 characters reaches the bot whole", () =>
    Effect.gen(function* () {
      const file = evalNotesFile(8 * 1024, { notes: [], messages: [] });
      const inForce = parseChannelBotNoteLines(file.text)
        .filter((note) => note.replacedBy === undefined)
        .map((note) => note.raw);
      const files = yield* notesFile(file.text);
      assert.deepStrictEqual((yield* readChannelBotNotes(files, "")).split("\n"), inForce);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("notes in force of exactly 9,000 characters go in whole, and one more is cut", () => {
    // Seventeen notes of 499 characters and one last note, joined by seventeen newlines.
    const notes = (last: number) =>
      Array.from({ length: 18 }, (_, at) => {
        const size = at === 17 ? last : 499;
        return "- 2026-03-01: " + String(at).padStart(2, "0") + "a".repeat(size - 16);
      });
    const exact = notes(500);
    assert.strictEqual(exact.join("\n").length, NOTES_SECTION_CHARS);
    assert.strictEqual(
      selectChannelBotNotes(NOTES_HEADER + exact.join("\n"), "").standing,
      exact.join("\n"),
    );
    const over = notes(501);
    const standing = selectChannelBotNotes(NOTES_HEADER + over.join("\n"), "").standing;
    assert.notInclude(standing.split("\n"), over[0]);
    assert.include(standing.split("\n"), over.at(-1));
  });

  it("never shows more than 9,000 characters, whatever the lines", () => {
    const long = Array.from({ length: 300 }, (_, at) =>
      line("deploy " + "y".repeat(460), "long-" + at),
    );
    const text = NOTES_HEADER + [...long, line("deploy " + "z".repeat(7_000), "huge")].join("\n");
    const notes = selectChannelBotNotes(text, "deploy");
    const section = [notes.matched, notes.standing].filter((part) => part !== "").join("\n");
    assert.isAtMost(section.length, NOTES_SECTION_CHARS);
    assert.isAbove(notes.matched.length, 0);
    // The oversized newest line is passed over; the standing notes before it stay.
    assert.include(notes.standing.split("\n"), long.at(-1));
  });

  it.effect("searches only the newest 256 KiB of the file", () =>
    Effect.gen(function* () {
      const oldest = line("The quarterly audit binder lives in cabinet nine.", "oldest");
      const inside = line("The quarterly audit checklist is pinned in #finance.", "inside");
      const before = filler(NOTES_SCAN_BYTES);
      const after = filler(20 * 1024);
      const files = yield* notesFile(
        NOTES_HEADER + [oldest, ...before, inside, ...after].join("\n") + "\n",
      );
      const section = yield* readChannelBotNotes(files, "Where is the quarterly audit?");
      assert.notInclude(section, oldest);
      assert.include(section, inside);
      assert.include(section, after.at(-1) ?? "");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("a correction hides the note it names wherever both sit, and an older duplicate stays", () => {
    const first = line("Use pnpm for the dashboard.", "first");
    const second = line("Use pnpm for the dashboard.", "second");
    const fix = line("Use bun for the dashboard.", "fix", "Use pnpm for the dashboard.");
    const text =
      NOTES_HEADER + [first, ...filler(12_000), second, ...filler(12_000), fix].join("\n");
    const notes = selectChannelBotNotes(text, "Which tool for the dashboard?");
    const shown = (notes.matched + "\n" + notes.standing).split("\n");
    assert.include(shown, fix);
    assert.include(shown, first);
    assert.notInclude(shown, second);
  });

  it("searches the start and the end of a long instruction, not its middle", () => {
    const note = line("The vendor portal password rotates every ninety days.", "portal");
    const text = NOTES_HEADER + [note, ...filler(12_000)].join("\n");
    const pad = "x ".repeat(3_000);
    assert.notInclude(selectChannelBotNotes(text, pad + "vendor portal" + pad).matched, note);
    assert.include(selectChannelBotNotes(text, pad + pad + "vendor portal").matched, note);
    assert.include(selectChannelBotNotes(text, "vendor portal" + pad + pad).matched, note);
  });

  it.effect(
    "reception sees an old matching note, and its memory read finds one by other words",
    () => {
      const old = line("The vendor portal password rotates every ninety days.", "portal");
      const harness = makeHarness();
      const seen: Array<string> = [];
      const results: Array<string> = [];
      harness.script.current = (input) => {
        if (input.mode !== "input") return defaultScript(input);
        if (input.readsAllowed === true) {
          seen.push(input.notes ?? "");
          return Effect.succeed({
            replyText: "",
            action: { type: "read", reads: [{ kind: "memory", query: "password rotation" }] },
          });
        }
        results.push(...(input.readResults ?? []).map((result) => result.text));
        return Effect.succeed({ replyText: "Okay.", action: { type: "report_only" } });
      };
      return Effect.gen(function* () {
        yield* setupBot;
        const fs = yield* FileSystem.FileSystem;
        const files = channelBotFilesFor(
          yield* Path.Path,
          (yield* ServerConfig.ServerConfig).stateDir,
        );
        yield* fs.makeDirectory(files.dir, { recursive: true });
        yield* fs.writeFileString(files.notes, NOTES_HEADER + [old, ...filler(12_000)].join("\n"));
        yield* (yield* ChannelGateway.ChannelGateway).ingest(
          goatInput("How often does the vendor portal change?", "portal-ask"),
          memoryRpcContext,
        );
        yield* (yield* ChannelRuntime.ChannelRuntime).drain;
        assert.lengthOf(seen, 1);
        assert.include(seen[0], old);
        assert.isTrue(results.some((text) => text.includes(old)));
      }).pipe(
        Effect.provide(harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
      );
    },
  );

  it.effect(
    "strips shared notes from the second reception pass after Slack memory is revoked",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const grantedScopes = [...owner.grantedScopes, "memory:read" as const];
        yield* linkSlackUser("U1", { ...owner, grantedScopes });
        const fs = yield* FileSystem.FileSystem;
        const files = channelBotFilesFor(
          yield* Path.Path,
          (yield* ServerConfig.ServerConfig).stateDir,
        );
        const note = line("The vendor rollout uses Indigo.", "vendor");
        yield* fs.makeDirectory(files.dir, { recursive: true });
        yield* fs.writeFileString(files.notes, NOTES_HEADER + note + "\n");
        const first = yield* dispatchBarrier;
        const prompts: Array<string | undefined> = [];
        harness.script.current = (input) => {
          if (input.mode !== "input") return defaultScript(input);
          prompts.push(input.notes);
          return input.readsAllowed === true
            ? first.pause.pipe(
                Effect.as({
                  replyText: "",
                  action: { type: "read", reads: [{ kind: "memory", query: "vendor rollout" }] },
                } as const),
              )
            : Effect.succeed({ replyText: "Okay.", action: { type: "report_only" } });
        };
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        yield* (yield* ChannelGateway.ChannelGateway).ingest(
          slackInput("How is the vendor rollout set up?", "revoked-reception-notes"),
          { ...slackContext, grantedScopes },
        );
        const reception = yield* Effect.forkScoped(runtime.drain);
        yield* first.reached;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE channel_identities SET granted_scopes_json = '["orchestration:read","orchestration:operate"]' WHERE connection_id = 'slack-1' AND external_actor_id = 'U1'`;
        yield* first.release;
        yield* Fiber.join(reception);
        assert.lengthOf(prompts, 2);
        assert.include(prompts[0] ?? "", note);
        assert.isUndefined(prompts[1]);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  describe("remote worker near the message limit", () => {
    const recent = line("Release builds are signed with the hardware key.", "recent");
    const text = NOTES_HEADER + [...filler(12_000), recent].join("\n");

    it("keeps the best matching note even when it is among the newest ones", () => {
      const instruction = "x".repeat(REMOTE_MESSAGE_CHARS - 2_500) + "\nSign the release build.";
      const message = remoteWorkerMessage(task(instruction), {
        notes: selectChannelBotNotes(text, instruction),
        skills: [],
      });
      assert.isAtMost(message.length, REMOTE_MESSAGE_CHARS);
      assert.strictEqual(notesBlock(message).split("\n")[0], recent);
    });

    it("sends no notes when the instruction leaves no room for one", () => {
      const bare = remoteWorkerMessage(task("Sign the release build."), {
        notes: EMPTY_NOTES,
        skills: [],
      });
      const instruction =
        "x".repeat(REMOTE_MESSAGE_CHARS - bare.length - 30) + "\nSign the release build.";
      const message = remoteWorkerMessage(task(instruction), {
        notes: selectChannelBotNotes(text, instruction),
        skills: [],
      });
      assert.isAtMost(message.length, REMOTE_MESSAGE_CHARS);
      assert.notInclude(message, "goat_bot_notes");
    });

    it("sends an instruction too long on its own as before, without notes", () => {
      const instruction = "x".repeat(REMOTE_MESSAGE_CHARS) + "\nSign the release build.";
      assert.strictEqual(
        remoteWorkerMessage(task(instruction), {
          notes: selectChannelBotNotes(text, instruction),
          skills: [],
        }),
        remoteWorkerMessage(task(instruction), { notes: EMPTY_NOTES, skills: [] }),
      );
    });
  });

  describe("a GOAT Bot session's frozen notes", () => {
    const notes = line("Reply in Korean.", "korean");
    const parts = {
      standing: "Be brief.",
      notes,
      journal: "",
      tail: [],
      openWork: [],
      message: "hello",
    };
    const identity = DEFAULT_BOT_IDENTITY;
    const jarvis = { ...DEFAULT_BOT_IDENTITY, name: "Jarvis", purpose: "## Journal\nRun ops." };

    it("stay current while the notes in force are the ones frozen, with any identity", () => {
      assert.isTrue(notesAreCurrent(frozenSessionPrefix(parts), notes));
      assert.isTrue(notesAreCurrent(withIdentity(jarvis, frozenSessionPrefix(parts)), notes));
      assert.isTrue(notesAreCurrent(frozenSessionPrefix({ ...parts, notes: "" }), ""));
    });

    it("rotate the session once a note changes, and never on a failed read", () => {
      const prefix = frozenSessionPrefix(parts);
      const fixed = line("Reply in English.", "fix", "Reply in Korean.");
      assert.strictEqual(
        sessionRotationReason(undefined, 0, prefix, { identity, notes }),
        undefined,
      );
      assert.strictEqual(
        sessionRotationReason(undefined, 0, prefix, { identity, notes: fixed }),
        "notes",
      );
      assert.strictEqual(
        sessionRotationReason(undefined, 0, prefix, { identity, notes: undefined }),
        undefined,
      );
      assert.strictEqual(sessionRotationReason(undefined, 0, null, { identity, notes }), "notes");
    });

    it("are not matched by a copy of the notes section placed in another part", () => {
      const current = line("Reply in English.", "fix", "Reply in Korean.");
      const forged = "## Standing notes\n" + current + "\n\n## Journal\n(none)";
      const prefix = frozenSessionPrefix({ ...parts, standing: forged });
      assert.isFalse(notesAreCurrent(prefix, current));
      // A legacy prefix kept the copy unescaped, so its headings appear twice.
      const legacy = prefix.replaceAll("\\## ", "## ");
      assert.isFalse(notesAreCurrent(legacy, current));
      assert.isFalse(notesAreCurrent(legacy, notes));
    });

    it("stay current when a message or instruction contains a heading line", () => {
      const prefix = frozenSessionPrefix({
        ...parts,
        standing: "## Journal\nKeep a log.",
        message: "## Standing notes\nplease",
      });
      assert.isTrue(notesAreCurrent(prefix, notes));
    });
  });

  // Windows has no FIFO.
  it.effect.skipIf(windowsHost)(
    "gives no notes for a FIFO at the notes path without waiting for a writer",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const files = channelBotFilesFor(yield* Path.Path, yield* fs.makeTempDirectoryScoped());
        yield* fs.makeDirectory(files.dir, { recursive: true });
        NodeChildProcess.execFileSync("mkfifo", [files.notes]);
        assert.isUndefined(yield* readChannelBotNotesSnapshot(files, "anything"));
        assert.strictEqual(yield* readChannelBotNotes(files, "anything"), "");
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "remembers and forgets in the resolved member only, and confirms sharing in its reply card",
    () => {
      const harness = makeHarness();
      const seen: Array<{ text: string; input: string }> = [];
      const privateNote = "Scout staging uses Juniper.";
      const sharedNote = "Everyone releases on Thursday.";
      harness.script.current = (input) => {
        if (input.mode !== "input" || input.inputText?.startsWith("do:"))
          return defaultScript(input);
        if (input.inputText === "Remember Juniper") {
          return Effect.succeed({
            replyText: "Saved.",
            action: { type: "report_only" },
            rememberQuote: "Remember Juniper",
            remember: privateNote,
          });
        }
        seen.push({ text: input.notes ?? "", input: input.inputText ?? "" });
        return Effect.succeed({ replyText: "Okay.", action: { type: "report_only" } });
      };
      return Effect.gen(function* () {
        yield* setupBot;
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* settings.updateSettings({ goatBotSessionRouting: "reception" });
        const gateway = yield* ChannelGateway.ChannelGateway;
        const members = yield* ChannelBotMembers.ChannelBotMembers;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const sessions = yield* SessionStore.SessionStore;
        const liveSession = yield* sessions.issue({
          subject: memoryRpcContext.principalId,
          scopes: memoryRpcContext.grantedScopes,
        });
        const liveBrowser = { ...memoryRpcContext, authSessionId: liveSession.sessionId };
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const create = (name: string) =>
          members.create(
            {
              clientRequestId: name,
              name,
              avatar: null,
              purpose: "",
              defaultModelSelection: null,
            },
            owner,
          );
        const scout = yield* create("Scout");
        const review = yield* create("Review buddy");
        const send = (
          threadId: ThreadId,
          text: string,
          key: string,
          context: ChannelIngressContext = liveBrowser,
        ) =>
          gateway.ingest(
            {
              ...goatInput(text, key),
              conversationKey: threadId,
              replyAddress: { kind: "goat", environmentId, threadId },
            },
            context,
          );
        const ask = (
          threadId: ThreadId,
          text: string,
          key: string,
          context?: ChannelIngressContext,
        ) => send(threadId, text, key, context).pipe(Effect.tap(() => runtime.drain));

        yield* ask(scout.sessionThreadId, "Remember Juniper", "private-note");
        yield* ask(
          review.sessionThreadId,
          goatBotForgetNoteMessage(privateNote, "private"),
          "wrong-forget",
        );
        const proposed = yield* ask(
          scout.sessionThreadId,
          "Remember for all bots: " + sharedNote,
          "propose-note",
        );
        yield* ask(botThreadId, "before confirmation", "before-confirm");
        assert.notInclude(seen.at(-1)?.text ?? "", sharedNote);
        const proposal = (yield* ledger.getInput(proposed.inputId))?.decision?.action;
        assert.strictEqual(proposal?.type, "clarify");
        if (proposal?.type !== "clarify") return;
        const option = proposal.options?.[0];
        assert.isString(option);
        if (option === undefined) return;

        yield* ask(scout.sessionThreadId, option, "confirm-note");
        yield* ask(scout.sessionThreadId, "scout authorized", "ask-scout");
        yield* ask(review.sessionThreadId, "review authorized", "ask-review");
        yield* ask(botThreadId, "main authorized", "ask-main");
        yield* ask(scout.sessionThreadId, "scout denied", "ask-denied", rpcContext);
        const shown = (query: string) => seen.find((item) => item.input === query)?.text ?? "";
        assert.include(shown("scout authorized"), privateNote);
        assert.include(shown("scout authorized"), sharedNote);
        assert.include(shown("review authorized"), sharedNote);
        assert.include(shown("main authorized"), sharedNote);
        assert.notInclude(shown("review authorized"), privateNote);
        assert.notInclude(shown("main authorized"), privateNote);
        assert.strictEqual(shown("scout denied"), "");
        const { sessionId } = yield* sessions.issue({
          subject: memoryRpcContext.principalId,
          scopes: memoryRpcContext.grantedScopes,
        });
        const browser = { ...memoryRpcContext, authSessionId: sessionId };
        yield* ask(scout.sessionThreadId, "scout live", "ask-live", browser);
        assert.include(shown("scout live"), privateNote);
        yield* send(scout.sessionThreadId, "scout revoked", "ask-revoked", browser);
        yield* sessions.revoke(sessionId);
        yield* runtime.drain;
        assert.strictEqual(shown("scout revoked"), "");
        assert.isTrue(seen.some(({ input }) => input === "scout revoked"));

        const work = (bot: typeof scout, title: string, context?: ChannelIngressContext) =>
          Effect.gen(function* () {
            yield* ask(bot.sessionThreadId, "do: " + title, title, context);
            const tasks = yield* ledger.listTasks({
              ownerId: owner.ownerId,
              botId: bot.botId,
              limit: 10,
            });
            const launched = tasks.tasks.find((task) => task.title === title);
            assert.isDefined(launched?.worker);
            const brief =
              launched === undefined ? undefined : yield* ledger.latestTaskBrief(launched.taskId);
            return brief?.deliveredText ?? "";
          });
        const scoutBrief = yield* work(scout, "scout worker");
        const reviewBrief = yield* work(review, "review worker");
        const deniedBrief = yield* work(scout, "worker without notes", rpcContext);
        assert.include(scoutBrief, privateNote);
        assert.include(scoutBrief, sharedNote);
        assert.include(reviewBrief, sharedNote);
        assert.notInclude(reviewBrief, privateNote);
        assert.notInclude(deniedBrief, privateNote);
        assert.notInclude(deniedBrief, sharedNote);

        yield* ask(
          scout.sessionThreadId,
          goatBotForgetNoteMessage(privateNote, "private"),
          "scout-forget",
        );
        yield* ask(scout.sessionThreadId, "after forget", "ask-after");
        assert.notInclude(shown("after forget"), privateNote);
        assert.include(shown("after forget"), sharedNote);
      }).pipe(
        Effect.provide(
          harness.layer.pipe(
            Layer.provideMerge(Layer.mergeAll(SqlitePersistence.layerMemory, layerSessionStore)),
          ),
        ),
      );
    },
  );

  describe("remote worker near the message limit", () => {
    const recent = line("Release builds are signed with the hardware key.", "recent");
    const text = NOTES_HEADER + [...filler(12_000), recent].join("\n");

    it("keeps the best matching note even when it is among the newest ones", () => {
      const instruction = "x".repeat(REMOTE_MESSAGE_CHARS - 2_500) + "\nSign the release build.";
      const message = remoteWorkerMessage(task(instruction), {
        notes: selectChannelBotNotes(text, instruction),
        skills: [],
      });
      assert.isAtMost(message.length, REMOTE_MESSAGE_CHARS);
      assert.strictEqual(notesBlock(message).split("\n")[0], recent);
    });

    it("sends no notes when the instruction leaves no room for one", () => {
      const bare = remoteWorkerMessage(task("Sign the release build."), {
        notes: EMPTY_NOTES,
        skills: [],
      });
      const instruction =
        "x".repeat(REMOTE_MESSAGE_CHARS - bare.length - 30) + "\nSign the release build.";
      const message = remoteWorkerMessage(task(instruction), {
        notes: selectChannelBotNotes(text, instruction),
        skills: [],
      });
      assert.isAtMost(message.length, REMOTE_MESSAGE_CHARS);
      assert.notInclude(message, "goat_bot_notes");
    });

    it("sends an instruction too long on its own as before, without notes", () => {
      const instruction = "x".repeat(REMOTE_MESSAGE_CHARS) + "\nSign the release build.";
      assert.strictEqual(
        remoteWorkerMessage(task(instruction), {
          notes: selectChannelBotNotes(text, instruction),
          skills: [],
        }),
        remoteWorkerMessage(task(instruction), { notes: EMPTY_NOTES, skills: [] }),
      );
    });
  });

  describe("a GOAT Bot session's frozen notes", () => {
    const notes = line("Reply in Korean.", "korean");
    const parts = {
      standing: "Be brief.",
      notes,
      journal: "",
      tail: [],
      openWork: [],
      message: "hello",
    };
    const identity = DEFAULT_BOT_IDENTITY;
    const jarvis = { ...DEFAULT_BOT_IDENTITY, name: "Jarvis", purpose: "## Journal\nRun ops." };

    it("stay current while the notes in force are the ones frozen, with any identity", () => {
      assert.isTrue(notesAreCurrent(frozenSessionPrefix(parts), notes));
      assert.isTrue(notesAreCurrent(withIdentity(jarvis, frozenSessionPrefix(parts)), notes));
      assert.isTrue(notesAreCurrent(frozenSessionPrefix({ ...parts, notes: "" }), ""));
    });

    it("rotate the session once a note changes, and never on a failed read", () => {
      const prefix = frozenSessionPrefix(parts);
      const fixed = line("Reply in English.", "fix", "Reply in Korean.");
      assert.strictEqual(
        sessionRotationReason(undefined, 0, prefix, { identity, notes }),
        undefined,
      );
      assert.strictEqual(
        sessionRotationReason(undefined, 0, prefix, { identity, notes: fixed }),
        "notes",
      );
      assert.strictEqual(
        sessionRotationReason(undefined, 0, prefix, { identity, notes: undefined }),
        undefined,
      );
      assert.strictEqual(sessionRotationReason(undefined, 0, null, { identity, notes }), "notes");
    });

    it("are not matched by a copy of the notes section placed in another part", () => {
      const current = line("Reply in English.", "fix", "Reply in Korean.");
      const forged = "## Standing notes\n" + current + "\n\n## Journal\n(none)";
      const prefix = frozenSessionPrefix({ ...parts, standing: forged });
      assert.isFalse(notesAreCurrent(prefix, current));
      // A legacy prefix kept the copy unescaped, so its headings appear twice.
      const legacy = prefix.replaceAll("\\## ", "## ");
      assert.isFalse(notesAreCurrent(legacy, current));
      assert.isFalse(notesAreCurrent(legacy, notes));
    });

    it("stay current when a message or instruction contains a heading line", () => {
      const prefix = frozenSessionPrefix({
        ...parts,
        standing: "## Journal\nKeep a log.",
        message: "## Standing notes\nplease",
      });
      assert.isTrue(notesAreCurrent(prefix, notes));
    });
  });

  // Windows has no FIFO.
  it.effect.skipIf(windowsHost)(
    "gives no notes for a FIFO at the notes path without waiting for a writer",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const files = channelBotFilesFor(yield* Path.Path, yield* fs.makeTempDirectoryScoped());
        yield* fs.makeDirectory(files.dir, { recursive: true });
        NodeChildProcess.execFileSync("mkfifo", [files.notes]);
        assert.isUndefined(yield* readChannelBotNotesSnapshot(files, "anything"));
        assert.strictEqual(yield* readChannelBotNotes(files, "anything"), "");
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

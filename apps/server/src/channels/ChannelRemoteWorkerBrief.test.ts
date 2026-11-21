import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { channelBotFilesFor } from "./channelBotNotes.ts";
import * as ChannelBotMembers from "./ChannelBotMembers.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import {
  linkSlackUser,
  makeHarness,
  onlyTask,
  owner,
  setupBot,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";
import { RemoteMachine, remoteScript, sha256 } from "./testing/RemoteMachine.ts";

const remoteHarness = () => {
  const machine = new RemoteMachine();
  const launch = Deferred.makeUnsafe<Parameters<NonNullable<typeof machine.beforeLaunch>>[0]>();
  machine.beforeLaunch = (input) => Deferred.succeed(launch, input).pipe(Effect.asVoid);
  const harness = makeHarness({ sshRemote: machine.layer });
  harness.script.current = remoteScript;
  return { launch: Deferred.await(launch), harness };
};

describe("what a worker on another machine is told", () => {
  it.effect(
    "carries this machine's GOAT Bot notes, the named skill, and the same safety rules",
    () => {
      const { launch, harness } = remoteHarness();
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const files = channelBotFilesFor(path, (yield* ServerConfig.ServerConfig).stateDir);
        yield* fs.makeDirectory(files.skills, { recursive: true });
        yield* fs.writeFileString(files.notes, "- 2026-10-17: open PRs as drafts (asked in x)\n");
        yield* fs.writeFileString(
          path.join(files.skills, "deploy-staging.md"),
          "# Deploy staging\nRun the deploy script, then check the health page.\n",
        );
        yield* fs.writeFileString(path.join(files.skills, "unrelated.md"), "# Unrelated\n");
        yield* setupBot;
        const grantedScopes = [...owner.grantedScopes, "memory:read" as const];
        yield* linkSlackUser("U1", { ...owner, grantedScopes });
        const gateway = yield* ChannelGateway.ChannelGateway;
        yield* gateway.ingest(
          slackInput("do@mac-studio: ship it with deploy-staging", "notes-remote"),
          { ...slackContext, grantedScopes },
        );
        yield* (yield* ChannelRuntime.ChannelRuntime).drain;
        const message = (yield* launch).message ?? "";
        assert.include(message, "<goat_bot_notes>\n- 2026-10-17: open PRs as drafts (asked in x)");
        assert.include(message, '<goat_bot_skill name="deploy-staging">\n# Deploy staging');
        assert.notInclude(message, "Unrelated");
        assert.include(message, "ask first: show the draft or plan in a needs_input report.");
        assert.include(message, 'goat_call {path:"origin.report"} with status progress');
        // The home machine's paths mean nothing over there.
        assert.notInclude(message, files.notes);
        const ledger = yield* ChannelLedger.ChannelLedger;
        const brief = yield* ledger.latestTaskBrief((yield* onlyTask).taskId);
        assert.strictEqual(
          brief?.context.notesRevision,
          sha256("- 2026-10-17: open PRs as drafts (asked in x)\n"),
        );
      }).pipe(Effect.provide(harness.layer));
    },
  );
  it.effect("does not embed notes when the Slack requester has no memory access", () => {
    const { launch, harness } = remoteHarness();
    return Effect.gen(function* () {
      const files = channelBotFilesFor(
        yield* Path.Path,
        (yield* ServerConfig.ServerConfig).stateDir,
      );
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(files.dir, { recursive: true });
      yield* fs.writeFileString(files.notes, "- 2026-10-17: open PRs as drafts (asked in x)\n");
      yield* setupBot;
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(
        slackInput("do@mac-studio: ship it", "notes-remote-denied"),
        slackContext,
      );
      yield* (yield* ChannelRuntime.ChannelRuntime).drain;
      const message = (yield* launch).message ?? "";
      assert.include(message, "ship it");
      assert.notInclude(message, "<goat_bot_notes>");
      assert.notInclude(message, "open PRs as drafts");
    }).pipe(Effect.provide(harness.layer));
  });
  it.effect("withholds a member's scoped notes from a remote worker for a denied requester", () => {
    const { launch, harness } = remoteHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser();
      const members = yield* ChannelBotMembers.ChannelBotMembers;
      const scout = yield* members.create(
        {
          clientRequestId: "remote-scout",
          name: "Scout",
          avatar: null,
          purpose: "",
          defaultModelSelection: null,
        },
        owner,
      );
      const files = channelBotFilesFor(
        yield* Path.Path,
        (yield* ServerConfig.ServerConfig).stateDir,
        scout.botId,
      );
      const fs = yield* FileSystem.FileSystem;
      const fact = "Use the synthetic Juniper key for rollout.";
      yield* fs.makeDirectory(files.dir, { recursive: true });
      yield* fs.writeFileString(files.notes, "- 2026-10-17: " + fact + " (asked in x)\n");
      const gateway = yield* ChannelGateway.ChannelGateway;
      const input = yield* gateway.ingest(
        slackInput("Scout: do@mac-studio: check rollout", "scout-remote-denied"),
        { ...slackContext, slackRouting: { allowName: true } },
      );
      const ledger = yield* ChannelLedger.ChannelLedger;
      assert.strictEqual((yield* ledger.getInput(input.inputId))?.botId, scout.botId);
      yield* (yield* ChannelRuntime.ChannelRuntime).drain;
      const message = (yield* launch).message ?? "";
      assert.include(message, "check rollout");
      assert.notInclude(message, fact);
      assert.notInclude(message, files.notes);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("freezes the readable shared snapshot when a member's private scope fails", () => {
    const { launch, harness } = remoteHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const grantedScopes = [...owner.grantedScopes, "memory:read" as const];
      yield* linkSlackUser("U1", { ...owner, grantedScopes });
      const scout = yield* (yield* ChannelBotMembers.ChannelBotMembers).create(
        {
          clientRequestId: "remote-scout-unreadable",
          name: "Scout",
          avatar: null,
          purpose: "",
          defaultModelSelection: null,
        },
        owner,
      );
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = (yield* ServerConfig.ServerConfig).stateDir;
      const own = channelBotFilesFor(path, stateDir, scout.botId);
      const shared = channelBotFilesFor(path, stateDir);
      const note = "- 2026-10-17: Use Juniper for the rollout. (asked in x)\n";
      yield* fs.makeDirectory(own.notes, { recursive: true });
      yield* fs.writeFileString(shared.notes, note);
      yield* (yield* ChannelGateway.ChannelGateway).ingest(
        slackInput("Scout: do@mac-studio: check rollout", "scout-remote-unreadable"),
        { ...slackContext, grantedScopes, slackRouting: { allowName: true } },
      );
      yield* (yield* ChannelRuntime.ChannelRuntime).drain;
      assert.include((yield* launch).message ?? "", note.trimEnd());
      const ledger = yield* ChannelLedger.ChannelLedger;
      const brief = yield* ledger.latestTaskBrief((yield* onlyTask).taskId);
      assert.strictEqual(brief?.context.notesRevision, sha256(note));
    }).pipe(Effect.provide(harness.layer));
  });
});

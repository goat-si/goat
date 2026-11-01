import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  SshWorkspaceError,
  SshWorkspaceCode,
  SshWorkspaceStage,
  EnvironmentAuthorizationError,
  AuthSourceControlWriteScope,
  type SshWorkspaceLaunchInput,
  type SshWorkspaceLaunchResult,
} from "@goat/contracts";
import { scopeProjectRef, scopeThreadRef } from "@goat/client-runtime/environment";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { snapshotDraftContent, isDraftContentUnchanged } from "../components/ChatView.logic";
import {
  submitSshWorktree,
  openSshThread,
  sshWorktreeErrorFeedback,
  type SshWorktreeSubmissionPorts,
} from "./sshWorktreeSubmission";
import { createModelSelection } from "@goat/shared/model";
const local = EnvironmentId.make("local"),
  remote = EnvironmentId.make("remote");
const id = DraftId.make("captured"),
  other = DraftId.make("other");
const destination = { connectionId: "saved", environmentId: remote };
const store = () => useComposerDraftStore.getState();
const launchInput: SshWorkspaceLaunchInput = {
  sourceProjectId: ProjectId.make("source"),
  destination: {
    connectionId: "saved",
    expectedEnvironmentId: remote,
    target: { alias: "build", hostname: "build", username: null, port: null },
  },
  title: "Text",
  modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "model"),
  runtimeMode: "full-access",
  interactionMode: "default",
  initialMessage: { text: "Text" },
};
const result: SshWorkspaceLaunchResult = {
  operationId: "12345678",
  snapshotRef: "ref",
  snapshotOid: "oid",
  remoteEnvironmentId: remote,
  remoteProjectId: ProjectId.make("remote-project"),
  remoteThreadId: ThreadId.make("remote-thread"),
  remoteRepoPath: "/remote",
  branch: "branch",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const snapshot = snapshotDraftContent(store().getComposerDraft(id)!);
  const ports: SshWorktreeSubmissionPorts = {
    launch: vi.fn(async () => result),
    reconnect: vi.fn(async () => {}),
    waitForShell: vi.fn(async () => true),
    navigate: vi.fn(async () => {}),
    isSubmittedDraftContentUnchanged: vi.fn(() =>
      isDraftContentUnchanged(snapshot, store().getComposerDraft(id)),
    ),
    deleteSubmittedDraft: vi.fn(() => store().clearDraftThread(id)),
    emptySubmittedDraftContent: vi.fn(() => store().clearComposerContent(id)),
  };
  return {
    ports,
    submit: () =>
      submitSshWorktree(
        { sourceEnvironmentId: local, savedEnvironmentId: remote, launchInput },
        ports,
      ),
  };
}
beforeEach(() => {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  for (const draftId of [id, other]) {
    store().setLogicalProjectDraftThreadId(
      draftId,
      scopeProjectRef(local, ProjectId.make(draftId)),
      draftId,
      { threadId: ThreadId.make(draftId), envMode: "worktree", sshDestination: destination },
    );
    store().setPrompt(draftId, "Text");
  }
});
describe("SSH submission content consumption", () => {
  it.each([false, true])(
    "returns opened after navigation and consumes only unchanged content (changed=%s)",
    async (changed) => {
      const { ports, submit } = fixture();
      const nav = deferred<void>();
      ports.navigate = vi.fn(() => nav.promise);
      const entered = deferred<void>();
      ports.waitForShell = vi.fn(async () => {
        entered.resolve();
        return true;
      });
      const pending = submit();
      await entered.promise;
      await Promise.resolve();
      expect(store().getDraftSession(id)).not.toBeNull();
      expect(ports.deleteSubmittedDraft).not.toHaveBeenCalled();
      if (changed) store().setPrompt(id, "new text");
      nav.resolve();
      expect((await pending).kind).toBe("opened");
      expect(ports.deleteSubmittedDraft).toHaveBeenCalledTimes(changed ? 0 : 1);
      expect(store().getDraftSession(other)).not.toBeNull();
      expect(store().getComposerDraft(other)?.prompt).toBe("Text");
      expect(ports.launch).toHaveBeenCalledWith({ environmentId: local, input: launchInput });
      expect(ports.waitForShell).toHaveBeenCalledWith(
        scopeThreadRef(remote, result.remoteThreadId),
        5000,
      );
    },
  );
  it.each([
    "timeout",
    "wait rejection",
    "route change",
    "identity mismatch",
    "router rejection",
  ] as const)(
    "returns started-not-opened for %s and conditionally clears captured content",
    async (failure) => {
      for (const changed of [false, true]) {
        store().setPrompt(id, "Text");
        const { ports, submit } = fixture();
        if (changed) store().setPrompt(id, "New text");
        if (failure === "timeout") ports.waitForShell = vi.fn(async () => false);
        if (failure === "wait rejection")
          ports.waitForShell = vi.fn(async () => {
            throw new Error("wait failed");
          });
        if (failure === "identity mismatch")
          ports.launch = vi.fn(async () => ({
            ...result,
            remoteEnvironmentId: EnvironmentId.make("wrong"),
          }));
        if (failure === "route change" || failure === "router rejection")
          ports.navigate = vi.fn(async () => {
            throw new Error(failure);
          });
        const outcome = await submit();
        expect(outcome).toMatchObject({
          kind: "started-not-opened",
          remoteRef: { threadId: result.remoteThreadId },
        });
        expect(ports.emptySubmittedDraftContent).toHaveBeenCalledTimes(changed ? 0 : 1);
        expect(ports.deleteSubmittedDraft).not.toHaveBeenCalled();
        expect(store().getDraftSession(id)?.sshDestination).toEqual(destination);
        expect(store().getDraftSessionByLogicalProjectKey(id)?.draftId).toBe(id);
        expect(store().getComposerDraft(id)?.prompt ?? "").toBe(changed ? "New text" : "");
        if (failure === "identity mismatch") {
          expect(ports.waitForShell).not.toHaveBeenCalled();
          expect(ports.navigate).not.toHaveBeenCalled();
        }
      }
    },
  );
  it.each([false, true])(
    "preserves a simulated desktop capture during deferred launch (open=%s)",
    async (opens) => {
      const { ports, submit } = fixture();
      const launch = deferred<SshWorkspaceLaunchResult>();
      ports.launch = vi.fn(() => launch.promise);
      ports.waitForShell = vi.fn(async () => opens);
      const pending = submit();
      store().addImages(id, [
        {
          id: "capture",
          type: "image",
          name: "capture.png",
          mimeType: "image/png",
          sizeBytes: 1,
          previewUrl: "blob:capture",
          file: new File(["x"], "capture.png"),
        },
      ]);
      launch.resolve(result);
      await pending;
      expect(store().getComposerDraft(id)?.prompt).toBe("Text");
      expect(store().getComposerDraft(id)?.images).toHaveLength(1);
      expect(ports.deleteSubmittedDraft).not.toHaveBeenCalled();
      expect(ports.emptySubmittedDraftContent).not.toHaveBeenCalled();
    },
  );
  it("launch rejection never compares or consumes current content", async () => {
    const { ports, submit } = fixture();
    ports.launch = vi.fn(async () => {
      throw new Error("failure");
    });
    await expect(submit()).rejects.toThrow("failure");
    expect(ports.isSubmittedDraftContentUnchanged).not.toHaveBeenCalled();
    expect(store().getComposerDraft(id)?.prompt).toBe("Text");
  });
  it("Open reconnects, waits and navigates without relaunching or mutating drafts", async () => {
    const { ports } = fixture();
    await openSshThread(
      { remoteRef: scopeThreadRef(remote, result.remoteThreadId), savedEnvironmentId: remote },
      ports,
    );
    expect(ports.reconnect).toHaveBeenCalledWith(remote);
    expect(ports.launch).not.toHaveBeenCalled();
    expect(ports.deleteSubmittedDraft).not.toHaveBeenCalled();
    expect(ports.emptySubmittedDraftContent).not.toHaveBeenCalled();
  });
});
describe("SSH error feedback", () => {
  it.each(SshWorkspaceCode.literals)("maps typed code %s without shell output", (code) => {
    const feedback = sshWorktreeErrorFeedback(
      new SshWorkspaceError({ code, stage: "launch" }),
      "Build",
      true,
    );
    expect(feedback.message.length).toBeGreaterThan(15);
    expect(feedback.message).not.toContain("<host>");
    expect(feedback.details).toBe(`Build · launch · ${code}`);
    expect(feedback.uncertain).toBe(code === "launch_uncertain");
  });
  it.each(SshWorkspaceStage.literals)("retains typed stage %s", (stage) =>
    expect(
      sshWorktreeErrorFeedback(
        new SshWorkspaceError({ code: "invalid_target", stage }),
        "Build",
        true,
      ).details,
    ).toContain(stage),
  );
  it("prioritizes uncertain dispatch and bounds credential-like filenames", () => {
    expect(sshWorktreeErrorFeedback({ launchMayHaveStarted: true }, "Build", false).message).toBe(
      "The thread may already have started on Build; check its threads before sending again.",
    );
    expect(sshWorktreeErrorFeedback(new Error("raw shell output"), "Build", true).uncertain).toBe(
      true,
    );
    expect(sshWorktreeErrorFeedback(new Error("raw shell output"), "Build", false).message).toBe(
      "Could not send to Build. Your draft was kept.",
    );
    expect(
      sshWorktreeErrorFeedback(
        new EnvironmentAuthorizationError({
          message: "denied",
          requiredScope: AuthSourceControlWriteScope,
        }),
        "Build",
        true,
      ).uncertain,
    ).toBe(false);
    expect(
      sshWorktreeErrorFeedback(
        new SshWorkspaceError({
          code: "secret_candidate",
          stage: "snapshot",
          fileNames: Array(20).fill("x".repeat(200)),
        }),
        "Build",
        true,
      ).details.length,
    ).toBeLessThan(1100);
  });
});

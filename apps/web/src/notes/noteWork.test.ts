import { ProjectId, type NotesStartWorkInput, type NotesStartWorkResult } from "@goat/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import type { NoteReply } from "./noteState";
import { NoteWorkSession, type NoteWorkDraft } from "./noteWork";

const draft: NoteWorkDraft = {
  path: "idea.md",
  target: { type: "hub", projectId: ProjectId.make("p1") },
  workspace: { type: "root" },
};
const failure: NoteReply<NotesStartWorkResult> = { ok: false, error: new Error("Connection lost") };
describe("note work launch attempts", () => {
  it("retries with the same request id and original target, model and workspace", async () => {
    const send = vi
      .fn<(input: NotesStartWorkInput) => Promise<NoteReply<NotesStartWorkResult>>>()
      .mockResolvedValue(failure);
    const session = new NoteWorkSession("attempt-1", send);
    await session.launch(draft);
    await session.launch({
      ...draft,
      target: { type: "host", host: "other", projectPath: "/project" },
      workspace: { type: "worktree", baseRef: "dev" },
    });
    expect(send.mock.calls[0]?.[0]).toEqual({ ...draft, requestId: "attempt-1" });
    expect(send.mock.calls[1]?.[0]).toBe(send.mock.calls[0]?.[0]);
  });
  it("never relaunches an ambiguous remote intent; only Start again creates another id", async () => {
    const send = vi
      .fn<(input: NotesStartWorkInput) => Promise<NoteReply<NotesStartWorkResult>>>()
      .mockResolvedValueOnce({
        ok: false,
        error: { reason: "launch_ambiguous", message: "Check host threads" },
      })
      .mockResolvedValue(failure);
    const remote: NoteWorkDraft = {
      ...draft,
      target: { type: "host", host: "mac", projectPath: "/repo" },
    };
    const session = new NoteWorkSession("attempt-1", send);
    await session.launch(remote);
    expect(session.getSnapshot().ambiguous).toBe(true);
    expect(await session.launch(remote)).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    session.startAgain("attempt-2");
    await session.launch(remote);
    expect(send.mock.calls[1]?.[0].requestId).toBe("attempt-2");
  });
  it("locks duplicate submissions and prevents restarting while a launch is pending", async () => {
    let respond!: (result: NoteReply<NotesStartWorkResult>) => void;
    const reply = new Promise<NoteReply<NotesStartWorkResult>>((resolve) => {
      respond = resolve;
    });
    const send = vi.fn().mockReturnValue(reply);
    const session = new NoteWorkSession("attempt-1", send);
    const first = session.launch(draft);
    expect(await session.launch(draft)).toBeNull();
    session.startAgain("attempt-2");
    expect(session.getSnapshot().requestId).toBe("attempt-1");
    respond(failure);
    await first;
    expect(send).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().busy).toBe(false);
  });
  it("settles transport rejection without losing the request id", async () => {
    const send = vi.fn().mockRejectedValue(new Error("Disconnected"));
    const session = new NoteWorkSession("attempt-1", send);
    await session.launch(draft);
    expect(session.getSnapshot()).toMatchObject({
      busy: false,
      ambiguous: false,
      requestId: "attempt-1",
      error: "Disconnected",
    });
  });
});

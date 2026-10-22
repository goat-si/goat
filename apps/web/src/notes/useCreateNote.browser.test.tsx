import {
  NoteError,
  type EnvironmentId,
  type NoteDocument,
  type NoteSummary,
} from "@goat/contracts";
import { createRef, useImperativeHandle, type Ref } from "react";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock(import("./useNoteCommand"), () => ({ useNoteCommand: (() => state.write) as never }));

import { act, render } from "../../test/render";
import type { NoteReply } from "./noteState";
import { useCreateNote } from "./useCreateNote";

type Create = (folder?: string | null) => Promise<NoteReply<NoteDocument>>;
const environmentId = "hub" as EnvironmentId;
const created = (path: string) => ({ ok: true, value: { path } as NoteDocument }) as const;
const existing = (path: string) => ({ path }) as NoteSummary;

function Harness({ notes, ref }: { notes: NoteSummary[]; ref: Ref<Create> }) {
  const create = useCreateNote(environmentId, notes);
  useImperativeHandle(ref, () => create);
  return null;
}
function setup() {
  state.write.mockReset();
  return createRef<Create>();
}
const writtenPaths = () => state.write.mock.calls.map(([call]) => call.input.path);

it("names notes Untitled and sends one write for presses that overlap", async () => {
  const create = setup();
  let finish!: (reply: NoteReply<NoteDocument>) => void;
  state.write.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
  await using screen = await render(<Harness notes={[existing("Untitled 2.md")]} ref={create} />);
  const first = create.current!();
  const second = create.current!();
  finish(created("Untitled.md"));
  expect(await first).toEqual(await second);
  expect(writtenPaths()).toEqual(["Untitled.md"]);

  state.write.mockResolvedValueOnce(created("Untitled 3.md"));
  await act(() =>
    screen.rerender(
      <Harness notes={[existing("Untitled.md"), existing("Untitled 2.md")]} ref={create} />,
    ),
  );
  await create.current!();
  expect(writtenPaths()).toEqual(["Untitled.md", "Untitled 3.md"]);
});

it("steps past a name another client took and can be retried after a failure", async () => {
  const create = setup();
  await using _screen = await render(<Harness notes={[]} ref={create} />);
  state.write
    .mockResolvedValueOnce({
      ok: false,
      error: new NoteError({ reason: "exists", message: "taken" }),
    })
    .mockResolvedValueOnce(created("goat/Untitled 2.md"));
  expect((await create.current!("goat")).ok).toBe(true);
  expect(writtenPaths()).toEqual(["goat/Untitled.md", "goat/Untitled 2.md"]);

  state.write
    .mockResolvedValueOnce({
      ok: false,
      error: new NoteError({ reason: "storage", message: "down" }),
    })
    .mockResolvedValueOnce(created("Untitled.md"));
  expect((await create.current!()).ok).toBe(false);
  expect((await create.current!()).ok).toBe(true);
});

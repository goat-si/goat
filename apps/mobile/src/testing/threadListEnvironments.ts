import { Atom } from "effect/reactivity";
import { createThreadListEnvironmentsAtom } from "../state/thread-list-environments";
export const threadListEnvironmentsAtom = createThreadListEnvironmentsAtom(
  Atom.make(new Map()),
  Atom.make([]),
);

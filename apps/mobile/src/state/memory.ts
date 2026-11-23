import { createMemoryEnvironmentAtoms } from "@goat/client-runtime/state/memory";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentThreadDetails } from "./threads";

export const memoryEnvironment = createMemoryEnvironmentAtoms(
  connectionAtomRuntime,
  undefined,
  (ref) => environmentThreadDetails.quietThreadAtom(ref),
);

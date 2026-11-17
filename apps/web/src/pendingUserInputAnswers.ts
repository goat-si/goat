import type { PendingUserInputDraftAnswer } from "@goat/client-runtime/state/user-input-draft";
import { create } from "zustand";

/** Typed answers to agents' questions, by request draft key and question id, for every surface. */
export const usePendingUserInputAnswers = create<
  Record<string, Record<string, PendingUserInputDraftAnswer>>
>(() => ({}));

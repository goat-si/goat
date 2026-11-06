import { ProviderSessionId, ProviderThreadId } from "@goat/contracts";
import { CodexAppServerRequestError } from "effect-codex-app-server/errors";
import { expect, it } from "vite-plus/test";
import { codexResumeError } from "./CodexResumeError.ts";

it("only treats Codex active-writer conflicts as a thread in use", () => {
  const session = ProviderSessionId.make("session");
  const thread = ProviderThreadId.make("thread");
  const conflict = new CodexAppServerRequestError({
    code: -32600,
    errorMessage: "thread already has an active writer",
  });
  expect(codexResumeError(conflict, session, thread, conflict)._tag).toBe(
    "ProviderAdapterThreadInUseError",
  );
  const other = new CodexAppServerRequestError({ code: -32600, errorMessage: "another problem" });
  expect(codexResumeError(other, session, thread, other)._tag).toBe(
    "ProviderAdapterResumeThreadError",
  );
});

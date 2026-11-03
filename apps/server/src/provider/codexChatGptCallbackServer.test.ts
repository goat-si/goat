// @effect-diagnostics nodeBuiltinImport:off - Exercises the real loopback listener.
import { expect, it } from "vite-plus/test";

import { listenForCallback } from "./codexChatGptCallbackServer.ts";

it("a callback server error after listening reaches the sign-in's failure route", async () => {
  const failures: Array<Error> = [];
  const server = await listenForCallback(
    (_request, response) => response.end(),
    (error) => failures.push(error),
  );
  try {
    const failure = new Error("accept failed");
    server.emit("error", failure);
    expect(failures).toEqual([failure]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

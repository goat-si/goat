import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** "later" was closed without an answer; neither it nor "answered" is asked again. */
export const FirstRunPromptState = Schema.Literals(["pending", "answered", "later"]);
export type FirstRunPromptState = typeof FirstRunPromptState.Type;

const firstRunPrompt = FirstRunPromptState.pipe(
  Schema.withDecodingDefault(Effect.succeed("pending" as const)),
);

/** Each question is independent; its answer lives in the setting it changes. */
export const FirstRunPrompts = Schema.Struct({
  computerUse: firstRunPrompt,
  opencodex: firstRunPrompt,
  goatclaw: firstRunPrompt,
});
export type FirstRunPrompts = typeof FirstRunPrompts.Type;
export type FirstRunPromptId = keyof FirstRunPrompts;

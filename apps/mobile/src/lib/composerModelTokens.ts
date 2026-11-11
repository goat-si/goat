import {
  collectComposerModelMentions,
  type ComposerModelMentionOccurrence,
} from "@goat/client-runtime/composer-model-mentions";

export function collectComposerModelTokens(
  text: string,
  previous: ReadonlyArray<ComposerModelMentionOccurrence> = [],
): ReadonlyArray<ComposerModelMentionOccurrence> {
  return collectComposerModelMentions(text).filter(
    (mention) =>
      /\s/u.test(text[mention.end] ?? "") ||
      previous.some((item) => item.start === mention.start && item.source === mention.source),
  );
}

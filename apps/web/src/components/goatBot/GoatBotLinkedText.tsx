import { splitGoatBotTextLinks } from "@goat/client-runtime/goatBot";

/** Bot text with its web addresses clickable; everything else stays plain text. */
export function GoatBotLinkedText({ text }: { readonly text: string }) {
  return splitGoatBotTextLinks(text).map((part, index) =>
    part.kind === "text" ? (
      part.text
    ) : (
      <a
        // oxlint-disable-next-line react/no-array-index-key -- parts are positional and never reorder
        key={index}
        href={part.url}
        target="_blank"
        rel="noreferrer"
        // Long addresses wrap where they are instead of dropping to their own line.
        className="text-info-foreground underline-offset-2 [overflow-wrap:anywhere] hover:underline"
      >
        {part.text}
      </a>
    ),
  );
}

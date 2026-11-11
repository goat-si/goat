import { hasGoatBotMarkdown, splitGoatBotTextLinks } from "@goat/client-runtime/goatBot";
import type { EnvironmentId } from "@goat/contracts";
import type { PluggableList } from "unified";

import ChatMarkdown from "../ChatMarkdown";
import { GOAT_BOT_REPLY_MARKDOWN_PLUGINS } from "./goatBotReplyMarkdown";

const WEB_ADDRESS = /https?:\/\//iu;

/**
 * Bot text. Markdown renders like a chat message in the bubble's type; plain text stays as
 * written with its web addresses clickable, so long histories only parse the rows that need it.
 */
export function GoatBotLinkedText({
  text,
  environmentId,
  markdownPlugins,
}: {
  readonly text: string;
  /** Where the shown history lives, so its thread links open there. */
  readonly environmentId: EnvironmentId | null;
  /** A card of a split reply passes the whole reply's link context. */
  readonly markdownPlugins?: PluggableList;
}) {
  // A web address renders as a link chip with its site's icon, which needs the Markdown path.
  // A card of a split reply is Markdown, and reads bare references against the whole reply.
  if (markdownPlugins !== undefined || hasGoatBotMarkdown(text) || WEB_ADDRESS.test(text)) {
    return (
      <ChatMarkdown
        text={text}
        cwd={undefined}
        environmentId={environmentId ?? undefined}
        fileActions={false}
        lineBreaks
        extraRemarkPlugins={markdownPlugins ?? GOAT_BOT_REPLY_MARKDOWN_PLUGINS}
      />
    );
  }
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

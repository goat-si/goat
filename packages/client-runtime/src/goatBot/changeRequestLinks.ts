import { sourceControlClients, type ReferenceAutolink } from "../sourceControlClients.ts";

const URL_PATTERN = /https?:\/\/[^\s<>"'`)\]]+/gu;

/** The one repository a reply's change request links name, with its host's reference finder. */
export interface GoatBotReplyRepository {
  readonly repository: string;
  readonly repositoryUrl: string;
  readonly references: (text: string) => ReadonlyArray<ReferenceAutolink>;
}

function changeRequestsIn(text: string) {
  return [...text.matchAll(URL_PATTERN)].flatMap((match) => {
    const parsed = sourceControlClients.parseChangeRequestUrl(match[0].replace(/[.,;:!?]+$/u, ""));
    return parsed === null ? [] : [parsed];
  });
}

/**
 * The repository a bot reply is about, when every pull request link in it is in one repository.
 * Only then can a bare reference number in the same reply be linked: the bot's chat has no
 * project.
 */
export function goatBotReplyRepository(text: string): GoatBotReplyRepository | null {
  const parsed = changeRequestsIn(text);
  const first = parsed[0];
  if (first === undefined) return null;
  if (parsed.some((entry) => entry.link.repositoryUrl !== first.link.repositoryUrl)) return null;
  const find = first.definition.referenceAutolinks;
  if (find === undefined) return null;
  const repositoryUrl = first.link.repositoryUrl;
  return {
    repository: first.link.repository,
    repositoryUrl,
    references: (value) => find(value, repositoryUrl).filter((link) => link.kind === "reference"),
  };
}

/**
 * How a pull request link reads in a bot reply: its number alone in the reply's one repository,
 * else with the repository before it; null for a link that is not a pull request.
 */
export function goatBotChangeRequestLabel(
  url: string,
  replyRepository: GoatBotReplyRepository | null,
): string | null {
  const parsed = sourceControlClients.parseChangeRequestUrl(url);
  if (parsed === null) return null;
  return parsed.link.repositoryUrl === replyRepository?.repositoryUrl
    ? `#${parsed.link.number}`
    : `${parsed.link.repository}#${parsed.link.number}`;
}

import { sourceControlClients, type ReferenceAutolink } from "../sourceControlClients.ts";

/** The one repository a reply's change request links name, with its host's reference finder. */
export interface GoatBotReplyRepository {
  readonly repository: string;
  readonly repositoryUrl: string;
  readonly references: (text: string) => ReadonlyArray<ReferenceAutolink>;
}

/**
 * A change request link on its host's public address. A look-alike or self-hosted address is
 * left as written, so a shortened label never hides which site a link opens.
 */
function trustedChangeRequest(url: string) {
  const parsed = sourceControlClients.parseChangeRequestUrl(url);
  if (parsed === null) return null;
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  return parsed.definition.publicHost === hostname ? parsed : null;
}

/**
 * The repository a bot reply is about, when every change request link in it (the reply's link
 * addresses, never text inside code) is on one trusted repository. Only then can a bare
 * reference number in the same reply be linked: the bot's chat has no project.
 */
export function goatBotReplyRepository(
  linkUrls: ReadonlyArray<string>,
): GoatBotReplyRepository | null {
  const parsed = linkUrls.flatMap((url) => {
    const trusted = trustedChangeRequest(url);
    return trusted === null ? [] : [trusted];
  });
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
 * How a change request link reads in a bot reply: its number alone in the reply's one
 * repository, else with the repository before it; GitLab merge requests use "!". Null for a
 * link that is not a change request on its host's public address.
 */
export function goatBotChangeRequestLabel(
  url: string,
  replyRepository: GoatBotReplyRepository | null,
): string | null {
  const parsed = trustedChangeRequest(url);
  if (parsed === null) return null;
  const mark = parsed.definition.publicHost === "gitlab.com" ? "!" : "#";
  return parsed.link.repositoryUrl === replyRepository?.repositoryUrl
    ? `${mark}${parsed.link.number}`
    : `${parsed.link.repository}${mark}${parsed.link.number}`;
}

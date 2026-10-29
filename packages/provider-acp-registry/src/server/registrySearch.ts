import type { AcpRegistryAgent } from "./AcpRegistrySupport.ts";

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function searchRank(agent: AcpRegistryAgent, query: string): number | undefined {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return 100;

  const id = agent.id.toLowerCase();
  const name = agent.name.toLowerCase();
  const authors = (agent.authors ?? []).join(" ").toLowerCase();
  const description = agent.description.toLowerCase();
  const terms = normalized.split(/\s+/u);
  if (id === normalized || name === normalized) return 0;
  if (id.startsWith(normalized) || name.startsWith(normalized)) return 10;

  const identityTokens = `${id} ${name}`.split(/[^a-z0-9]+/u).filter(Boolean);
  if (terms.every((term) => identityTokens.some((token) => token.startsWith(term)))) return 20;
  if (terms.every((term) => id.includes(term) || name.includes(term))) return 30;
  if (terms.every((term) => authors.includes(term))) return 40;
  if (terms.every((term) => `${id} ${name} ${authors} ${description}`.includes(term))) return 50;
  return undefined;
}

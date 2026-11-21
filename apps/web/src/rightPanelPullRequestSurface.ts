import type { PullRequestDetailTab, PullRequestSurface } from "./rightPanelStore";

export function pullRequestSurfaceId(target: {
  environmentId?: string;
  projectId: string;
  host?: string;
  repository: string;
  number: number;
}): PullRequestSurface["id"] {
  const scope =
    target.environmentId === undefined ? "" : `${encodeURIComponent(target.environmentId)}:`;
  const host = target.host === undefined ? "" : `${encodeURIComponent(target.host.toLowerCase())}:`;
  return `pull-request:${scope}${encodeURIComponent(target.projectId)}:${host}${encodeURIComponent(target.repository)}:${target.number}`;
}

export function pullRequestSurface(target: {
  environmentId?: string;
  projectId: string;
  host?: string;
  repository: string;
  number: number;
  url?: string;
  detailTab?: PullRequestDetailTab;
}): PullRequestSurface {
  return {
    id: pullRequestSurfaceId(target),
    kind: "pull-request",
    ...(target.environmentId === undefined ? {} : { environmentId: target.environmentId }),
    projectId: target.projectId,
    ...(typeof target.host === "string" ? { host: target.host.toLowerCase() } : {}),
    repository: target.repository,
    number: target.number,
    ...(typeof target.url === "string" ? { url: target.url } : {}),
    ...(target.detailTab === undefined ? {} : { detailTab: target.detailTab }),
  };
}

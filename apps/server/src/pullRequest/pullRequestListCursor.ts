import type {
  ProviderAcrossListCursor,
  ProviderChangeRequest,
  ProviderListCursor,
} from "@goat/source-control-core/server/PullRequestProvider";

export interface ListCursor extends ProviderListCursor {
  readonly seenAt: ReadonlyArray<number>;
}

export const MAX_CURSOR_BOUNDARY_IDENTITIES = 128;

export function listCursorKey(host: string, repository: string): string {
  return `${host} ${repository.toLowerCase()}`;
}

// Preserve exclusions across slices sharing a timestamp to avoid redelivery.
export function nextListCursor(
  previous: ListCursor | undefined,
  fetched: ReadonlyArray<ProviderChangeRequest>,
  delivered: ReadonlyArray<ProviderChangeRequest>,
  /** A provider may consume malformed offset-paged rows that never appear in `delivered`. */
  cursorAdvance = delivered.length,
  resumeAfter?: string,
): string | null {
  if (fetched.length === 0) return null;
  // Use all fetched rows: a slice containing only duplicates must still advance to older rows.
  const oldest = fetched.reduce((left, right) => (right.updatedAt < left.updatedAt ? right : left));
  return listCursorAt(previous, oldest.updatedAt, fetched, cursorAdvance, resumeAfter);
}

export function listCursorAt(
  previous: ListCursor | undefined,
  boundary: string,
  fetched: ReadonlyArray<ProviderChangeRequest>,
  deliveredCount: number,
  resumeAfter?: string,
): string | null {
  const seenAt = new Set([
    ...(previous?.updatedBefore === boundary ? previous.seenAt : []),
    ...fetched.filter((item) => item.updatedAt === boundary).map((item) => item.number),
  ]);
  if (seenAt.size > MAX_CURSOR_BOUNDARY_IDENTITIES) return null;
  const cursor = `${boundary}|${(previous?.delivered ?? 0) + deliveredCount}|${[...seenAt].join(",")}`;
  return resumeAfter === undefined ? cursor : `${cursor}|${resumeAfter}`;
}

export function acrossListCursor<T extends { readonly repository: string }>(
  cursor: ListCursor,
  projects: ReadonlyArray<T>,
  cursorOf: (project: T) => ListCursor | undefined,
): ProviderAcrossListCursor {
  return {
    updatedBefore: cursor.updatedBefore,
    delivered: cursor.delivered,
    seenAt: projects.flatMap((project) => {
      const previous = cursorOf(project);
      return previous?.updatedBefore === cursor.updatedBefore
        ? previous.seenAt.map((number) => ({ repository: project.repository, number }))
        : [];
    }),
  };
}

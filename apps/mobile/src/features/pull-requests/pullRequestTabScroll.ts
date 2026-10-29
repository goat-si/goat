export function pullRequestTabOffset(
  current: number,
  saved: number | undefined,
  headerEnd: number,
) {
  return current < headerEnd ? current : Math.max(headerEnd, saved ?? headerEnd);
}

export function restorePullRequestTabScroll(
  list:
    | { getNativeScrollRef(): { scrollTo(options: { y: number; animated: boolean }): void } }
    | null
    | undefined,
  options: {
    current: number;
    saved: number | undefined;
    bodyY: number;
    topInset: number;
    platform: string;
  },
) {
  const top = options.platform === "ios" ? options.topInset : 0;
  const headerEnd = Math.max(-top, options.bodyY - top);
  const offset = pullRequestTabOffset(options.current, options.saved, headerEnd);
  list?.getNativeScrollRef().scrollTo({ y: offset, animated: false });
  return offset;
}

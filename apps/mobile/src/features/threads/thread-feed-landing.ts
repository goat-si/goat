export function feedHeaderHidden(hasEntries: boolean, listLoaded: boolean): boolean {
  return hasEntries && !listLoaded;
}

export function feedHasLanded(input: {
  loaded: boolean;
  distanceFromEnd: number;
  followsEnd: boolean;
  jumping: boolean;
  measured?: boolean;
}): boolean {
  return (
    input.loaded &&
    (!input.followsEnd || input.jumping || (input.measured !== false && input.distanceFromEnd <= 2))
  );
}

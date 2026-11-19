export function feedHeaderHidden(hasEntries: boolean, listLoaded: boolean): boolean {
  return hasEntries && !listLoaded;
}

export function feedHasLanded(input: {
  loaded: boolean;
  distanceFromEnd: number;
  followsEnd: boolean;
  jumping: boolean;
}): boolean {
  return input.loaded && (input.distanceFromEnd <= 2 || !input.followsEnd || input.jumping);
}

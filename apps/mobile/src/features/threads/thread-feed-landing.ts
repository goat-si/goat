export function feedHeaderHidden(hasEntries: boolean, listLoaded: boolean): boolean {
  return hasEntries && !listLoaded;
}

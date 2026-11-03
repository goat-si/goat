export const ENVIRONMENT_HUE_SLOT_COUNT = 8;

export function environmentHueSlot(environmentId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < environmentId.length; index += 1) {
    hash = Math.imul(hash ^ environmentId.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0) % ENVIRONMENT_HUE_SLOT_COUNT;
}

// Earlier sorted ids claim collisions; matching input sets (excluding each hub) give matching hues.
export function assignEnvironmentHueSlots(
  environmentIds: ReadonlyArray<string>,
): ReadonlyMap<string, number> {
  const taken = new Set<number>();
  const hues = new Map<string, number>();
  for (const environmentId of [...new Set(environmentIds)].sort()) {
    if (taken.size === ENVIRONMENT_HUE_SLOT_COUNT) taken.clear();
    let slot = environmentHueSlot(environmentId);
    while (taken.has(slot)) slot = (slot + 1) % ENVIRONMENT_HUE_SLOT_COUNT;
    taken.add(slot);
    hues.set(environmentId, slot);
  }
  return hues;
}

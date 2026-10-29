// Page-lifetime: /welcome and the app shell mount separate link coordinators, and a pairing
// URL's one-time token stays spent after either of them pairs it.
const spentPairingUrls = new Set<string>();

export function isPairingLinkSpent(pairingUrl: string): boolean {
  return spentPairingUrls.has(pairingUrl);
}

export function markPairingLinkSpent(pairingUrl: string): void {
  spentPairingUrls.add(pairingUrl);
}

export function resetSpentPairingLinksForTests(): void {
  spentPairingUrls.clear();
}

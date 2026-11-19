const PAIRING_CODE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/i;

export function normalizePairingCode(credential: string): string {
  const compact = credential.replace(/[\s-]/g, "");
  return PAIRING_CODE.test(compact) ? compact.toUpperCase() : credential;
}

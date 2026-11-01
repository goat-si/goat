import {
  decodeThirdPartyLicenseManifest,
  type ThirdPartyLicenseManifest,
} from "@goat/shared/thirdPartyLicenses";

let cachedManifest: ThirdPartyLicenseManifest | undefined;

export function getMobileThirdPartyLicenses(): ThirdPartyLicenseManifest {
  if (cachedManifest) return cachedManifest;
  const generatedManifest: unknown = require("@goat/mobile-third-party-licenses");
  cachedManifest = decodeThirdPartyLicenseManifest(generatedManifest);
  return cachedManifest;
}

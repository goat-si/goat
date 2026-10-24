import { sign as signApplication, type SignOptions } from "@electron/osx-sign";

// electron-builder hands over whichever certificate's name matched "-"; an unsigned build that
// embeds the computer use helper must be ad-hoc whatever it matched (desktop-artifact-computer-use.ts).
export default async function sign(options: SignOptions): Promise<void> {
  await signApplication({
    ...options,
    identity: "-",
    identityValidation: false,
    batchCodesignCalls: true,
  });
}

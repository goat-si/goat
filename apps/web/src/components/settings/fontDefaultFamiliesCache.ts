interface FontDefaultFamilies {
  readonly sans: string;
  readonly code: string;
}

/**
 * Keeps the probed default font labels while fonts are settled. A web font finishing loading or
 * the window regaining focus (a font may have been installed meanwhile) probes again.
 */
export function makeFontDefaultFamiliesCache(
  fonts: EventTarget & { readonly status: string },
  windowTarget: EventTarget,
) {
  let cached: FontDefaultFamilies | undefined;
  const forget = () => {
    cached = undefined;
  };
  fonts.addEventListener("loadingdone", forget);
  windowTarget.addEventListener("focus", forget);
  return {
    get(probe: () => FontDefaultFamilies): FontDefaultFamilies {
      if (cached !== undefined) return cached;
      const families = probe();
      if (fonts.status === "loaded") cached = families;
      return families;
    },
  };
}

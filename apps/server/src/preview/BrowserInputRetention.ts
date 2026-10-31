type Evidence = { readonly finish: () => Promise<boolean> };

export function makeBrowserInputRetention(
  start: () => Promise<Evidence>,
  consent: () => Promise<boolean>,
  safe: () => boolean,
) {
  let evidence: Evidence | undefined;
  return {
    onFocus: async () => {
      try {
        if ((await consent()) && safe()) evidence = await start();
      } catch {
        evidence = undefined;
      }
    },
    finish: async () => {
      if (evidence === undefined) return false;
      const captured = evidence;
      evidence = undefined;
      try {
        const observed = await captured.finish();
        return observed && (await consent()) && safe();
      } catch {
        return false;
      }
    },
  };
}

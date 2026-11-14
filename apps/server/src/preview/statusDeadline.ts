// @effect-diagnostics globalTimers:off - Playwright status reads run outside the Effect runtime.
export const withinStatusDeadline = <A>(read: Promise<A>, late: () => A): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<A>((resolve) => {
    timer = setTimeout(() => resolve(late()), 250);
  });
  return Promise.race([read, deadline]).finally(() => clearTimeout(timer));
};

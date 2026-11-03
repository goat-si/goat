export const makeCuaDriverGenerationFence = () => {
  let fenced = false;
  let unknown = false;
  let newest = 0;
  let lastSeen: number | undefined;
  let sawUnknown = false;
  return {
    observe: (generation: number | undefined) => {
      if (generation === undefined || !Number.isSafeInteger(generation) || generation < 1)
        sawUnknown = true;
      else lastSeen = Math.max(lastSeen ?? 0, generation);
    },
    last: () => (sawUnknown ? undefined : lastSeen),
    fence: (generation: number | undefined) => {
      fenced = true;
      if (generation === undefined || !Number.isSafeInteger(generation) || generation < 1)
        unknown = true;
      else newest = Math.max(newest, generation);
    },
    allows: (generation: number | undefined) =>
      !fenced ||
      (!unknown &&
        generation !== undefined &&
        Number.isSafeInteger(generation) &&
        generation > newest),
  };
};

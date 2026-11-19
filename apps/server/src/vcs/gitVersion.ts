export const gitSupportsPathspecFromFile = (versionOutput: string): boolean => {
  const match = /^git version (\d+)\.(\d+)/.exec(versionOutput);
  if (match === null) return false;
  const major = Number(match[1]);
  return major > 2 || (major === 2 && Number(match[2]) >= 25);
};

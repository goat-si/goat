import * as HostProcess from "../HostProcess.ts";

const WINDOWS_RESERVED_CHARACTERS = '<>:"|?*';

/**
 * Windows cannot store control characters such as newlines or `<>:"|?*` in a
 * file name, and drops a trailing space or dot. Hostile-name fixtures keep the
 * names this host can create instead of failing at setup.
 */
export const hostCanStoreFileName = (name: string): boolean =>
  HostProcess.Platform.defaultValue() !== "win32" ||
  !(
    /[ .]$/.test(name) ||
    [...name].some(
      (character) => character < " " || WINDOWS_RESERVED_CHARACTERS.includes(character),
    )
  );

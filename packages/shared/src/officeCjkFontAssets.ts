const officeCjkAsset = /^Noto(?:Sans(?:JP|KR|SC|TC)|SerifSC)-Regular(?:-[\w-]+)?\.otf$/;

export const isOfficeCjkFontAsset = (name: string): boolean => officeCjkAsset.test(name);

export const MAX_OFFICE_CJK_FONT_ARCHIVE_BYTES = 48 * 1024 * 1024;
export const OFFICE_CJK_FONT_MANIFEST_SUFFIX = ".fonts.sha256";

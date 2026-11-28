type Oklab = Readonly<{ l: number; a: number; b: number }>;

function colorToOklab(value: string): Oklab {
  const oklch =
    /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+(-?[\d.]+)(?:deg)?(?:\s*\/[^)]+)?\s*\)$/i.exec(value);
  if (oklch) {
    const hue = (Number(oklch[4]) * Math.PI) / 180;
    return {
      l: Number(oklch[1]) / (oklch[2] ? 100 : 1),
      a: Number(oklch[3]) * Math.cos(hue),
      b: Number(oklch[3]) * Math.sin(hue),
    };
  }

  const [red, green, blue] = srgbChannels(value).map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const m = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const s = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/** Red, green and blue from 0 to 1, from a hex or rgb() color. */
function srgbChannels(value: string): readonly [number, number, number] {
  const hex = /^#([\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.exec(value)?.[1];
  if (hex !== undefined) {
    const digits = hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex;
    const at = (offset: number) => Number.parseInt(digits.slice(offset, offset + 2), 16) / 255;
    return [at(0), at(2), at(4)];
  }
  const rgb = /^rgba?\(\s*([\d.]+%?)[,\s]+([\d.]+%?)[,\s]+([\d.]+%?)(?:\s*[,/][^)]+)?\s*\)$/i.exec(
    value,
  );
  if (rgb === null) throw new Error(`Unsupported theme color: ${value}`);
  const at = (channel = "0") => Number.parseFloat(channel) / (channel.endsWith("%") ? 100 : 255);
  return [at(rgb[1]), at(rgb[2]), at(rgb[3])];
}

/** Mix opaque palette/native colors like CSS color-mix(in oklab), then encode for React Native. */
export function mixOklab(first: string, second: string, weightOfFirst: number): string {
  const a = colorToOklab(first.trim());
  const b = colorToOklab(second.trim());
  const weightOfSecond = 1 - weightOfFirst;
  const lightness = a.l * weightOfFirst + b.l * weightOfSecond;
  const axisA = a.a * weightOfFirst + b.a * weightOfSecond;
  const axisB = a.b * weightOfFirst + b.b * weightOfSecond;
  const l = (lightness + 0.3963377774 * axisA + 0.2158037573 * axisB) ** 3;
  const m = (lightness - 0.1055613458 * axisA - 0.0638541728 * axisB) ** 3;
  const s = (lightness - 0.0894841775 * axisA - 1.291485548 * axisB) ** 3;
  const channels = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((channel) => {
    const srgb = channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, srgb)) * 255)
      .toString(16)
      .padStart(2, "0");
  });
  return `#${channels.join("")}`;
}

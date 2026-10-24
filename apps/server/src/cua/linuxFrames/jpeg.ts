/**
 * A baseline JPEG encoder for the Linux live frames of a computer use session (#1370): the
 * frame contract carries JPEG only, and the server has no image library. Sequential DCT,
 * 4:4:4 YCbCr, the standard tables of ITU-T T.81 Annex K scaled by quality.
 *
 * @module jpeg
 */

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
  13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52,
  45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

const LUMA_QUANT = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113,
  92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const CHROMA_QUANT = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99,
  47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
];

/** Huffman table spec: code counts by length 1..16, then the symbols in order. */
interface HuffmanSpec {
  readonly counts: ReadonlyArray<number>;
  readonly symbols: ReadonlyArray<number>;
}
const LUMA_DC: HuffmanSpec = {
  counts: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0],
  symbols: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};
const CHROMA_DC: HuffmanSpec = {
  counts: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
  symbols: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};
const LUMA_AC: HuffmanSpec = {
  counts: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
  symbols: [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
    0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
    0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
    0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
    0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
    0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
    0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
    0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
    0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
    0xf9, 0xfa,
  ],
};
const CHROMA_AC: HuffmanSpec = {
  counts: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
  symbols: [
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
    0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
    0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
    0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
    0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
    0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
    0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
    0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
    0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
    0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
    0xf9, 0xfa,
  ],
};

/** Code and length per symbol, built canonically from a table spec (T.81 Annex C). */
function huffmanCodes(spec: HuffmanSpec): Map<number, readonly [number, number]> {
  const codes = new Map<number, readonly [number, number]>();
  let code = 0;
  let index = 0;
  for (let length = 1; length <= 16; length++) {
    for (let count = 0; count < (spec.counts[length - 1] ?? 0); count++)
      codes.set(spec.symbols[index++] ?? 0, [code++, length]);
    code <<= 1;
  }
  return codes;
}
const CODES = {
  lumaDc: huffmanCodes(LUMA_DC),
  lumaAc: huffmanCodes(LUMA_AC),
  chromaDc: huffmanCodes(CHROMA_DC),
  chromaAc: huffmanCodes(CHROMA_AC),
};

/** A quant table scaled by quality 1..100 as libjpeg does, in natural order. */
function scaledQuant(base: ReadonlyArray<number>, quality: number): ReadonlyArray<number> {
  const q = Math.min(100, Math.max(1, Math.round(quality)));
  const scale = q < 50 ? 5000 / q : 200 - q * 2;
  return base.map((value) => Math.min(255, Math.max(1, Math.floor((value * scale + 50) / 100))));
}

const COS = Array.from({ length: 64 }, (_, index) => {
  const x = Math.floor(index / 8);
  const u = index % 8;
  return Math.cos(((2 * x + 1) * u * Math.PI) / 16);
});
const C = (u: number) => (u === 0 ? Math.SQRT1_2 : 1);

/** The 8x8 forward DCT of a level-shifted block, quantized, in zigzag order. */
function quantizedBlock(block: Float64Array, quant: ReadonlyArray<number>): Int32Array {
  const rows = new Float64Array(64);
  for (let y = 0; y < 8; y++)
    for (let u = 0; u < 8; u++) {
      let sum = 0;
      for (let x = 0; x < 8; x++) sum += (block[y * 8 + x] ?? 0) * (COS[x * 8 + u] ?? 0);
      rows[y * 8 + u] = sum;
    }
  const out = new Int32Array(64);
  for (let v = 0; v < 8; v++)
    for (let u = 0; u < 8; u++) {
      let sum = 0;
      for (let y = 0; y < 8; y++) sum += (rows[y * 8 + u] ?? 0) * (COS[y * 8 + v] ?? 0);
      const coefficient = (C(u) * C(v) * sum) / 4;
      const natural = v * 8 + u;
      out[ZIGZAG.indexOf(natural)] = Math.round(coefficient / (quant[natural] ?? 1));
    }
  return out;
}

class BitWriter {
  private bytes: number[] = [];
  private buffer = 0;
  private count = 0;
  write(code: number, length: number) {
    for (let bit = length - 1; bit >= 0; bit--) {
      this.buffer = (this.buffer << 1) | ((code >> bit) & 1);
      if (++this.count === 8) {
        this.bytes.push(this.buffer);
        // A 0xFF data byte is followed by a stuffed zero so it never reads as a marker.
        if (this.buffer === 0xff) this.bytes.push(0);
        this.buffer = 0;
        this.count = 0;
      }
    }
  }
  /** Pads the last byte with ones, as T.81 requires. */
  finish(): number[] {
    if (this.count > 0) this.write((1 << (8 - this.count)) - 1, 8 - this.count);
    return this.bytes;
  }
}

/** The magnitude category of a coefficient and its bits (T.81 F.1.2.1). */
const category = (value: number) => {
  const magnitude = Math.abs(value);
  let size = 0;
  while (magnitude >> size) size++;
  const bits = value < 0 ? value + (1 << size) - 1 : value;
  return [size, bits] as const;
};

function encodeBlock(
  writer: BitWriter,
  coefficients: Int32Array,
  previousDc: number,
  dc: Map<number, readonly [number, number]>,
  ac: Map<number, readonly [number, number]>,
): number {
  const emit = (table: Map<number, readonly [number, number]>, symbol: number) => {
    const entry = table.get(symbol);
    if (entry === undefined) throw new Error("JPEG: no Huffman code for symbol " + symbol);
    writer.write(entry[0], entry[1]);
  };
  const value = coefficients[0] ?? 0;
  const [size, bits] = category(value - previousDc);
  emit(dc, size);
  if (size > 0) writer.write(bits, size);
  let zeros = 0;
  for (let index = 1; index < 64; index++) {
    const coefficient = coefficients[index] ?? 0;
    if (coefficient === 0) {
      zeros++;
      continue;
    }
    while (zeros > 15) {
      emit(ac, 0xf0);
      zeros -= 16;
    }
    const [acSize, acBits] = category(coefficient);
    emit(ac, (zeros << 4) | acSize);
    writer.write(acBits, acSize);
    zeros = 0;
  }
  if (zeros > 0) emit(ac, 0x00);
  return value;
}

const segment = (marker: number, body: ReadonlyArray<number>) => [
  0xff,
  marker,
  (body.length + 2) >> 8,
  (body.length + 2) & 0xff,
  ...body,
];

const huffmanSegment = (tableClass: number, id: number, spec: HuffmanSpec) => [
  (tableClass << 4) | id,
  ...spec.counts,
  ...spec.symbols,
];

/** Packed RGB (3 bytes a pixel) as a baseline JPEG. */
export function encodeJpeg(
  rgb: Uint8Array,
  width: number,
  height: number,
  quality: number,
): Uint8Array {
  if (
    width < 1 ||
    height < 1 ||
    width > 65_535 ||
    height > 65_535 ||
    rgb.length < width * height * 3
  )
    throw new Error("JPEG: bad image size");
  const luma = scaledQuant(LUMA_QUANT, quality);
  const chroma = scaledQuant(CHROMA_QUANT, quality);
  const writer = new BitWriter();
  const blocks = [new Float64Array(64), new Float64Array(64), new Float64Array(64)] as const;
  const previous = [0, 0, 0];
  for (let top = 0; top < height; top += 8)
    for (let left = 0; left < width; left += 8) {
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++) {
          // Edge blocks repeat the last row and column.
          const px = Math.min(width - 1, left + x);
          const py = Math.min(height - 1, top + y);
          const at = (py * width + px) * 3;
          const r = rgb[at] ?? 0;
          const g = rgb[at + 1] ?? 0;
          const b = rgb[at + 2] ?? 0;
          blocks[0][y * 8 + x] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
          blocks[1][y * 8 + x] = -0.168736 * r - 0.331264 * g + 0.5 * b;
          blocks[2][y * 8 + x] = 0.5 * r - 0.418688 * g - 0.081312 * b;
        }
      previous[0] = encodeBlock(
        writer,
        quantizedBlock(blocks[0], luma),
        previous[0] ?? 0,
        CODES.lumaDc,
        CODES.lumaAc,
      );
      previous[1] = encodeBlock(
        writer,
        quantizedBlock(blocks[1], chroma),
        previous[1] ?? 0,
        CODES.chromaDc,
        CODES.chromaAc,
      );
      previous[2] = encodeBlock(
        writer,
        quantizedBlock(blocks[2], chroma),
        previous[2] ?? 0,
        CODES.chromaDc,
        CODES.chromaAc,
      );
    }
  const scan = writer.finish();
  const bytes = [
    0xff,
    0xd8,
    ...segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...segment(0xdb, [
      0,
      ...ZIGZAG.map((natural) => luma[natural] ?? 1),
      1,
      ...ZIGZAG.map((natural) => chroma[natural] ?? 1),
    ]),
    ...segment(0xc0, [
      8,
      height >> 8,
      height & 0xff,
      width >> 8,
      width & 0xff,
      3,
      1,
      0x11,
      0,
      2,
      0x11,
      1,
      3,
      0x11,
      1,
    ]),
    ...segment(0xc4, [
      ...huffmanSegment(0, 0, LUMA_DC),
      ...huffmanSegment(1, 0, LUMA_AC),
      ...huffmanSegment(0, 1, CHROMA_DC),
      ...huffmanSegment(1, 1, CHROMA_AC),
    ]),
    ...segment(0xda, [3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]),
  ];
  const out = new Uint8Array(bytes.length + scan.length + 2);
  out.set(bytes);
  out.set(scan, bytes.length);
  out[out.length - 2] = 0xff;
  out[out.length - 1] = 0xd9;
  return out;
}

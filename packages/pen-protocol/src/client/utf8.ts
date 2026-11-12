// A fatal, streaming UTF-8 decoder (WHATWG decoder rules), so text survives being split across frames and
// nothing depends on TextDecoder, which Hermes may lack.

export class Utf8Decoder {
  #needed = 0;
  #seen = 0;
  #codePoint = 0;
  #lower = 0x80;
  #upper = 0xbf;
  #parts: Array<string> = [];
  #pending: Array<number> = [];

  /** Adds bytes; false when they are not UTF-8 (the decoder is then unusable). */
  push(bytes: Uint8Array): boolean {
    for (const byte of bytes) {
      if (this.#needed === 0) {
        if (byte <= 0x7f) {
          this.#emit(byte);
          continue;
        }
        if (byte >= 0xc2 && byte <= 0xdf) {
          this.#needed = 1;
          this.#codePoint = byte & 0x1f;
        } else if (byte >= 0xe0 && byte <= 0xef) {
          if (byte === 0xe0) this.#lower = 0xa0;
          if (byte === 0xed) this.#upper = 0x9f;
          this.#needed = 2;
          this.#codePoint = byte & 0xf;
        } else if (byte >= 0xf0 && byte <= 0xf4) {
          if (byte === 0xf0) this.#lower = 0x90;
          if (byte === 0xf4) this.#upper = 0x8f;
          this.#needed = 3;
          this.#codePoint = byte & 0x7;
        } else {
          return false;
        }
        continue;
      }
      if (byte < this.#lower || byte > this.#upper) return false;
      this.#lower = 0x80;
      this.#upper = 0xbf;
      this.#codePoint = (this.#codePoint << 6) | (byte & 0x3f);
      this.#seen += 1;
      if (this.#seen === this.#needed) {
        this.#emit(this.#codePoint);
        this.#needed = 0;
        this.#seen = 0;
        this.#codePoint = 0;
      }
    }
    return true;
  }

  /** False when the input ended inside a code point. */
  finish(): boolean {
    return this.#needed === 0;
  }

  /** The text decoded so far. */
  take(): string {
    this.#flush();
    const text = this.#parts.join("");
    this.#parts = [];
    return text;
  }

  #emit(codePoint: number): void {
    this.#pending.push(codePoint);
    if (this.#pending.length >= 8192) this.#flush();
  }

  #flush(): void {
    if (this.#pending.length === 0) return;
    this.#parts.push(String.fromCodePoint(...this.#pending));
    this.#pending = [];
  }
}

/** The text of complete UTF-8 bytes, or null. */
export function decodeUtf8(bytes: Uint8Array): string | null {
  const decoder = new Utf8Decoder();
  return decoder.push(bytes) && decoder.finish() ? decoder.take() : null;
}

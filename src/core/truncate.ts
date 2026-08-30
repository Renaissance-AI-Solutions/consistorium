/**
 * Shared byte-bounded truncation.
 *
 * Every bounded output (document reads, git diffs) caps a payload at a byte
 * budget. Cutting a UTF-8 buffer at an arbitrary index splits multi-byte
 * characters, and decoding the remainder replaces each stray byte with U+FFFD —
 * which is *three* bytes, so a naive cut can return more bytes than the budget
 * allowed. These helpers cut on a character boundary instead, so the result is
 * always a genuine prefix of the input and always within budget.
 *
 * The truncation marker is appended by callers and is deliberately outside the
 * budget: it is a fixed-size signal, not payload.
 */

export const TRUNCATION_MARKER = "\n... [truncated]";

/** Byte length a UTF-8 lead byte announces for its character. */
function sequenceLength(lead: number): number {
  if (lead < 0x80) return 1;
  if ((lead & 0xe0) === 0xc0) return 2;
  if ((lead & 0xf0) === 0xe0) return 3;
  if ((lead & 0xf8) === 0xf0) return 4;
  return 1; // malformed lead: treat as a single byte
}

/**
 * Largest index `end <= maxBytes` such that `buf.subarray(0, end)` ends on a
 * UTF-8 character boundary.
 *
 * The buffer is not assumed to be well-formed: a bounded file read can itself
 * end mid-character, so the final sequence is checked for completeness even
 * when the whole buffer fits within the budget.
 */
function safeByteEnd(buf: Buffer, maxBytes: number): number {
  const end = Math.min(Math.max(maxBytes, 0), buf.length);
  if (end === 0) return 0;

  // Walk back from the cut to the lead byte of the character spanning it.
  // A UTF-8 character is at most 4 bytes, so at most 3 continuation bytes.
  let i = end - 1;
  let back = 0;
  while (i >= 0 && (buf[i]! & 0xc0) === 0x80 && back < 3) {
    i--;
    back++;
  }
  if (i < 0) return 0; // nothing but continuation bytes: no complete character

  // Drop that character when it would run past the cut.
  return i + sequenceLength(buf[i]!) > end ? i : end;
}

/** Truncate `text` to at most `maxBytes` UTF-8 bytes without splitting a character. */
export function truncateToBytes(
  text: string,
  maxBytes: number
): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf-8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  return { text: buf.subarray(0, safeByteEnd(buf, maxBytes)).toString("utf-8"), truncated: true };
}

/**
 * Decode at most `maxBytes` of `buf` without splitting a character. Used where
 * the payload arrives as bytes (a bounded file read) rather than as a string.
 *
 * The second pass costs nothing for well-formed input and holds the byte bound
 * even for a file that is not valid UTF-8, where decoding substitutes U+FFFD
 * and can otherwise grow the payload past the budget.
 */
export function truncateBufferToBytes(buf: Buffer, maxBytes: number): string {
  const decoded = buf.subarray(0, safeByteEnd(buf, maxBytes)).toString("utf-8");
  return truncateToBytes(decoded, maxBytes).text;
}

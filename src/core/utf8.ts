import { StringDecoder } from "node:string_decoder";

/** Decode a bounded UTF-8 prefix without inventing a replacement character
 * for a final, incomplete code point. The truncation marker is outside the
 * payload byte budget. Do not flush the decoder's pending suffix with end().
 */
export function decodeUtf8Prefix(bytes: Buffer): string {
  return new StringDecoder("utf8").write(bytes);
}

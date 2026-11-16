/** Base64 conversion for binary data embedded in backup files. Pure; works in browsers and in Node. */

const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  // Converted in chunks: spreading a large array into one call overflows the argument limit.
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Decodes standard base64. Returns null when the text is not valid base64. */
export function base64ToBytes(text: string): Uint8Array<ArrayBuffer> | null {
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

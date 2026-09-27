/**
 * Builds a "shadow" copy of the text with the same UTF-16 length, so detectors can run on the shadow and offsets map
 * 1:1 back to the original:
 * - Devanagari digits ०-९ → 0-9;
 * - fullwidth digits ０-９ → 0-9;
 * - fullwidth @ and exotic spaces (NBSP, thin space, …) → ASCII.
 */
export function shadow(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0x0966 && c <= 0x096f) out += String.fromCharCode(0x30 + c - 0x0966);
    else if (c >= 0xff10 && c <= 0xff19) out += String.fromCharCode(0x30 + c - 0xff10);
    else if (c === 0xff20) out += '@';
    else if (c === 0x00a0 || (c >= 0x2000 && c <= 0x200a) || c === 0x202f || c === 0x3000) out += ' ';
    else out += text.charAt(i);
  }
  return out;
}

/** Digits of a string with O/o read as zero (Devanagari already shadowed). */
export function digitsOf(s: string): string {
  let out = '';
  for (const ch of s) {
    if (ch >= '0' && ch <= '9') out += ch;
    else if (ch === 'O' || ch === 'o') out += '0';
  }
  return out;
}

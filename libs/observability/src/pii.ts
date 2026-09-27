// Pattern-based PII scrubbing: the last line of defence for free text (log messages, stack frames).
// The primary control is the field allow-list (fields.ts); this catches PII typed into a message by mistake.
// libs/redaction owns the full detectors (names, addresses); plug it in through `redactMessage`.

/** Replacement for anything that looks like a phone number or an e-mail address. */
export const REDACTED = '[redacted]';

// An e-mail address, including obfuscated spacing around '@' and dots (e.g. "a.b @ x . com").
const EMAIL = /[A-Za-z0-9._%+-]+\s*@\s*[A-Za-z0-9-]+(?:\s*\.\s*[A-Za-z0-9-]+)*/g;
// Seven or more digits, allowing the separators people type in phone numbers: spaces, dashes, dots, brackets and a
// leading '+'. Covers every Indian format (+91 98765 43210, 098765-43210, (022) 2345 6789, 91-9876543210, …).
const DIGIT_RUN = /\+?\(?\d(?:[\s\-().]{0,3}\d){6,}\)?/g;

/** Masks e-mail addresses and phone-like digit runs (≥ 7 digits) in free text. */
export function scrubText(text: string): string {
  return text.replace(EMAIL, REDACTED).replace(DIGIT_RUN, REDACTED);
}

/** True when the text holds something `scrubText` would mask. */
export function containsPii(text: string): boolean {
  return scrubText(text) !== text;
}

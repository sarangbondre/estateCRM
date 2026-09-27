import { spansOf, type Span } from './span.js';

const AT_OBFUSCATED = String.raw`(?:\s*[[({<]\s*at\s*[\])}>]\s*|\s+at\s+|\s*\(@\)\s*)`;
const DOT_OBFUSCATED = String.raw`(?:\s*[[({<]\s*dot\s*[\])}>]\s*|\s+dot\s+|\.)`;
const TLDS = 'com|in|net|org|co|info|biz|io|me|edu|gov|ac|us|uk|ae|invalid|test|example|live|email|mail';

/** Plain e-mail: "name@example.com", "name @ example.co.in". */
const EMAIL = /[A-Za-z0-9][A-Za-z0-9._%+-]*\s?@\s?[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,10}\b/gu;
/** Obfuscated e-mail: "name at example dot com", "name[at]example.com", "name (at) example [dot] in". */
const EMAIL_OBFUSCATED = new RegExp(
  String.raw`\b[A-Za-z0-9][A-Za-z0-9._%+-]*${AT_OBFUSCATED}[A-Za-z0-9-]+(?:${DOT_OBFUSCATED}[A-Za-z0-9-]+)*?${DOT_OBFUSCATED}(?:${TLDS})\b`,
  'giu',
);

const URL_TLDS =
  'com|in|co\\.in|net|org|info|biz|io|app|site|online|realty|homes|properties|estate|me|ly|gl|to|link|page';
/** URLs, WhatsApp/Telegram links and bare domains. Trailing punctuation is left outside the span. */
const URL = new RegExp(
  String.raw`(?:\b(?:https?:\/\/|www\.)|\b(?:wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com|t\.me)\/)[^\s<>"']*[^\s<>"'.,;:!?)\]]` +
    String.raw`|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:${URL_TLDS})\b(?:\/[^\s<>"']*[^\s<>"'.,;:!?)\]])?`,
  'giu',
);

/** PAN (AAAAA9999A, 4th letter = holder type), GSTIN (embeds a PAN), Aadhaar (12 digits, first 2-9, 4-4-4). */
const PAN = /\b[A-Z]{3}[ABCFGHJLPT][A-Z]\d{4}[A-Z]\b/gu;
const GSTIN = /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/gu;
const AADHAAR = /(?<![\w])[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}(?![\w])/gu;
/** Any other long bare digit run (bank account, VID, …) unless it is a price. RERA ids have a letter prefix. */
const LONG_DIGITS = /(?<![\w.,])\d{9,18}(?![\w.,])/gu;
const MONEY_BEFORE = /(?:rs\.?|inr|₹|price|rate|cost|value|amount)\s*[:-]?\s*$/iu;

export function detectEmails(text: string): Span[] {
  return [...spansOf(text, EMAIL, 'EMAIL'), ...spansOf(text, EMAIL_OBFUSCATED, 'EMAIL')];
}

export function detectUrls(text: string): Span[] {
  return spansOf(text, URL, 'URL');
}

export function detectIds(text: string): Span[] {
  const long = spansOf(text, LONG_DIGITS, 'ID').filter(
    (s) => !MONEY_BEFORE.test(text.slice(Math.max(0, s.start - 12), s.start)),
  );
  return [
    ...spansOf(text, PAN, 'ID'),
    ...spansOf(text, GSTIN, 'ID'),
    ...spansOf(text, AADHAAR, 'ID'),
    ...long,
  ];
}

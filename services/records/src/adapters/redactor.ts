// Contact redaction of free text (desk item descriptions, LLD §3.16) with libs/redaction.
import { redact } from '@11e/redaction';
import type { Redactor } from '../application/ports.js';

export const contactRedactor: Redactor = {
  redact: (text: string) => redact(text, { kinds: ['PHONE', 'EMAIL', 'URL', 'UNIT', 'ID'] }).text,
};

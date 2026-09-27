// Validates contracts/asyncapi/events.yaml with the official AsyncAPI parser (task F-04).
import { readFile } from 'node:fs/promises';
import { Parser } from '@asyncapi/parser';

const file = new URL('../../contracts/asyncapi/events.yaml', import.meta.url);
const { document, diagnostics } = await new Parser().parse(await readFile(file, 'utf8'), { source: file.pathname });
const errors = diagnostics.filter((d) => d.severity === 0);
for (const d of errors) process.stderr.write(`error ${d.code} ${d.path?.join('.')}: ${d.message}\n`);
if (!document || errors.length) process.exit(1);
process.stdout.write(`asyncapi ok: ${document.messages().length} messages, ${document.operations().length} operations\n`);

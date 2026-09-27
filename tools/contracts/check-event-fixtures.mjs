// Validates every event fixture against its AsyncAPI payload schema; fails if a fixture is missing or invalid.
import { existsSync, readFileSync } from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { events, root } from './events.mjs';

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

let bad = 0;
const all = events();
for (const e of all) {
  const file = new URL(`contracts/fixtures/events/${e.type}.json`, root);
  if (!existsSync(file)) {
    process.stderr.write(`missing fixture: ${e.type}\n`);
    bad++;
    continue;
  }
  const validate = ajv.compile(e.schema);
  if (!validate(JSON.parse(readFileSync(file, 'utf8')))) {
    process.stderr.write(`${e.type}: ${ajv.errorsText(validate.errors)}\n`);
    bad++;
  }
}
if (bad) {
  process.stderr.write(`${bad} invalid event fixture(s)\n`);
  process.exit(1);
}
process.stdout.write(`event fixtures ok: ${all.length}\n`);

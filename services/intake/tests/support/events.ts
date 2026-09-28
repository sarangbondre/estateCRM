// Validates produced envelopes against the AsyncAPI payload schemas (contracts/asyncapi/events.yaml) with Ajv,
// using the repo's contract tooling to load and dereference the document.
import { Ajv } from 'ajv';
import type { ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';

// ajv-formats is CommonJS; under NodeNext its default export is the module object.
const addFormats = addFormatsModule as unknown as (ajv: Ajv) => Ajv;

interface EventDef {
  type: string;
  producer: string;
  schema: object;
}

let loaded: Promise<Map<string, ValidateFunction>> | undefined;

async function validators(): Promise<Map<string, ValidateFunction>> {
  loaded ??= (async () => {
    const url = new URL('../../../../tools/contracts/events.mjs', import.meta.url).href;
    const mod = (await import(url)) as { events: () => EventDef[] };
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    return new Map(mod.events().map((e) => [e.type, ajv.compile(e.schema)]));
  })();
  return loaded;
}

/** Throws when the envelope does not match its event's payload schema. */
export async function validateEvent(envelope: { eventType: string }): Promise<void> {
  const v = (await validators()).get(envelope.eventType);
  if (!v) throw new Error(`unknown event type ${envelope.eventType}`);
  if (!v(envelope as unknown)) {
    throw new Error(
      `${envelope.eventType}: ${(v.errors ?? []).map((e) => `${e.instancePath} ${e.message}`).join('; ')}`,
    );
  }
}

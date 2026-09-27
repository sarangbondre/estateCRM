// Shared helpers for event tooling: loads contracts/asyncapi/events.yaml and resolves each message payload.
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';

export const root = new URL('../../', import.meta.url);
export const doc = load(readFileSync(new URL('contracts/asyncapi/events.yaml', root), 'utf8'));

const deref = (node, seen = new Set()) => {
  if (Array.isArray(node)) return node.map((n) => deref(n, seen));
  if (!node || typeof node !== 'object') return node;
  if (typeof node.$ref === 'string') {
    const ref = node.$ref;
    if (!ref.startsWith('#/')) throw new Error(`external $ref not supported: ${ref}`);
    if (seen.has(ref)) throw new Error(`circular $ref: ${ref}`);
    const target = ref
      .slice(2)
      .split('/')
      .reduce((o, k) => o?.[k], doc);
    if (target === undefined) throw new Error(`unresolved $ref: ${ref}`);
    return deref(target, new Set([...seen, ref]));
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, deref(v, seen)]));
};

/** @returns {{ type: string, producer: string, consumers: string[], schema: object }[]} */
export const events = () =>
  Object.values(doc.components.messages).map((m) => ({
    type: m.name,
    producer: m['x-producer'],
    consumers: m['x-consumers'] ?? [],
    schema: deref(m.payload),
  }));

export const queueOf = (consumer) => `q_${consumer.replaceAll('-', '_')}`;

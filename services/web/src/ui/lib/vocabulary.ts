'use client';
// The controlled vocabulary (records GET /v1/vocabulary, BRD §4.2): every dropdown in cards comes from it, never free
// text. Loaded once per page and shared.
import { useEffect, useState } from 'react';
import type { operations as Records } from '@11e/contracts/records';
import { get } from './api';
import type { Ok } from './contract';

export type Vocabulary = Ok<Records['getVocabulary']>;

let cached: Promise<Vocabulary> | null = null;

export function loadVocabulary(): Promise<Vocabulary> {
  cached ??= get<Vocabulary>('/v1/vocabulary').catch((err: unknown) => {
    cached = null;
    throw err;
  });
  return cached;
}

export function useVocabulary(): { vocab: Vocabulary | undefined; error: unknown } {
  const [state, setState] = useState<{ vocab?: Vocabulary; error?: unknown }>({});
  useEffect(() => {
    let live = true;
    loadVocabulary().then(
      (vocab) => live && setState({ vocab }),
      (error: unknown) => live && setState({ error }),
    );
    return () => {
      live = false;
    };
  }, []);
  return { vocab: state.vocab, error: state.error };
}

/** Values of a vocabulary field (snake_case BRD name, e.g. `deal_type`), optionally narrowed by segment. */
export function valuesOf(vocab: Vocabulary | undefined, field: string, segment?: string | null): string[] {
  const f = vocab?.fields[field];
  if (!f) return [];
  if (segment && f.bySegment?.[segment]) return f.bySegment[segment] ?? [];
  return f.values ?? [];
}

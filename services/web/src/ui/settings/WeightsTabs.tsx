'use client';
// Settings → Life curve, Queue weights, Match weights (WEB-08; US-34, BRD §4.5, D-12, PRD §4.2 / §4.5): everyone in
// Settings reads them, Admin edits. Load current values, validate against the contract (min/max, fresh < ageing <
// stale, weights not all 0), PUT with If-Match row version. Contract: journeys get/putLifeCurveThresholds,
// get/putQueueWeights; crm-engine getWeights / putWeights.
import type { ReactNode } from 'react';
import { ActionButton, Done, Loading } from '../cards/Card';
import { date } from '../lib/format';
import type { TabProps } from './types';
import { NumberInput, Section, SettingsError, useNumericSettings } from './shared';
import type { NumericSettings } from './shared';
import {
  CATEGORY_LABEL,
  DEMAND_CATEGORIES,
  LIFE_CURVE_FIELDS,
  MATCH_FACTOR_FIELDS,
  MATCH_TUNING_FIELDS,
  MATCH_WEIGHT_FIELDS,
  OFFER_CATEGORIES,
  QUEUE_WEIGHT_FIELDS,
  STAGES,
  shares,
  validateLifeCurve,
  validateMatchWeights,
  validateQueueWeights,
} from './logic';
import type { LifeCurveThresholds, MatchWeights, NumField, QueueWeights } from './logic';

type Versioned = { version: number; updatedAt?: string | null };

function Meta({ data }: { data: Versioned | undefined }) {
  if (!data) return null;
  return (
    <span className="faint small">
      Version {data.version}
      {data.updatedAt ? ` · last changed ${date(data.updatedAt, true)}` : ''}
    </span>
  );
}

function SaveBar<T extends Versioned>({ s, editable }: { s: NumericSettings<T>; editable: boolean }) {
  if (!editable) return <p className="faint small" style={{ margin: 0 }}>Read-only. Only an Admin can change these values.</p>;
  const messages = [...new Set(Object.values(s.errors))];
  return (
    <>
      {messages.length > 0 && (
        <div role="alert" className="err-note">
          {messages.slice(0, 6).join(' ')}
          {messages.length > 6 ? ` (+${messages.length - 6} more)` : ''}
        </div>
      )}
      <div className="row">
        <ActionButton primary pending={s.saving} disabled={!s.dirty} onClick={s.save}>
          Save
        </ActionButton>
        <button type="button" className="btn" disabled={!s.dirty} onClick={s.reset}>
          Reset
        </button>
        {s.saved && <Done>Saved</Done>}
      </div>
      {s.saveError !== undefined && <SettingsError error={s.saveError} onReload={s.reload} />}
    </>
  );
}

function Grid({ fields, s, editable, share }: { fields: readonly NumField[]; s: NumericSettings<Versioned>; editable: boolean; share?: Record<string, number> }) {
  return (
    <div className="form-grid">
      {fields.map((f) => {
        const pct = share?.[f.path];
        return editable ? (
          <NumberInput
            key={f.path}
            label={f.label}
            value={s.draft[f.path] ?? ''}
            onChange={(v) => s.set(f.path, v)}
            error={s.errors[f.path]}
            min={f.min}
            max={f.max}
            integer={f.integer}
            hint={pct !== undefined ? `Effective share ${Math.round(pct * 100)}%` : rangeHint(f)}
          />
        ) : (
          <div key={f.path} className="field">
            <span className="faint small">{f.label}</span>
            <span className="num">
              {s.draft[f.path] || '—'}
              {pct !== undefined && <span className="faint"> ({Math.round(pct * 100)}%)</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

const rangeHint = (f: NumField) => (f.max !== undefined ? `${f.min} to ${f.max}` : `at least ${f.min}`);

function Loader<T>({ s, children }: { s: NumericSettings<T>; children: () => ReactNode }) {
  if (s.loadError !== undefined) return <SettingsError error={s.loadError} onReload={s.reload} />;
  if (s.loading || !s.data) return <Loading />;
  return <>{children()}</>;
}

// ------------------------------------------------------------------ life curve

export function LifeCurveTab({ editable }: TabProps) {
  const s = useNumericSettings<LifeCurveThresholds>('/v1/settings/life-curve-thresholds', LIFE_CURVE_FIELDS, validateLifeCurve);
  const rows: ['offer' | 'demand', string][] = [
    ...OFFER_CATEGORIES.map((c) => ['offer', c] as ['offer', string]),
    ...DEMAND_CATEGORIES.map((c) => ['demand', c] as ['demand', string]),
  ];
  return (
    <Section
      title="Life-curve thresholds"
      actions={<Meta data={s.data} />}
      note="Each value is the last day of the stage; after Stale the record is Expired. Pagdi follows Sale · Secondary (D-12). Stage changes from new values apply on the next nightly run."
    >
      <Loader s={s}>
        {() => (
          <>
            <div className="tw" tabIndex={0} role="region" aria-label="Scrollable table">
              <table>
                <thead>
                  <tr>
                    <th>Category</th>
                    <th>Side</th>
                    {STAGES.map(([k, l]) => (
                      <th key={k} className="n">
                        {l}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(([side, c]) => (
                    <tr key={`${side}.${c}`}>
                      <td>{CATEGORY_LABEL[c] ?? c}</td>
                      <td>{side === 'offer' ? 'Supply' : 'Demand'}</td>
                      {STAGES.map(([k, l]) => {
                        const path = `${side}.${c}.${k}`;
                        return (
                          <td key={k} className="n">
                            {editable ? (
                              <NumberInput
                                label={`${CATEGORY_LABEL[c] ?? c}, ${side === 'offer' ? 'supply' : 'demand'}: ${l}`}
                                hideLabel
                                value={s.draft[path] ?? ''}
                                onChange={(v) => s.set(path, v)}
                                error={s.errors[path] ? 'Check' : undefined}
                                min={1}
                                integer
                              />
                            ) : (
                              (s.draft[path] ?? '—')
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Grid fields={LIFE_CURVE_FIELDS.slice(-2)} s={s as NumericSettings<Versioned>} editable={editable} />
            <SaveBar s={s} editable={editable} />
          </>
        )}
      </Loader>
    </Section>
  );
}

// ------------------------------------------------------------------ queue weights

const QUEUE_SHARE_PATHS = ['freshness', 'demandGap', 'sourceQuality', 'priceBand'];

export function QueueWeightsTab({ editable }: TabProps) {
  const s = useNumericSettings<QueueWeights>('/v1/settings/queue-weights', QUEUE_WEIGHT_FIELDS, validateQueueWeights);
  const share = shares(s.draft, QUEUE_SHARE_PATHS);
  return (
    <Section
      title="Should call ranking"
      actions={<Meta data={s.data} />}
      note="The four weights are normalised by their sum. Ranks are recomputed by the next refresh (within 5 minutes)."
    >
      <Loader s={s}>
        {() => (
          <>
            <Grid fields={QUEUE_WEIGHT_FIELDS.slice(0, 4)} s={s as NumericSettings<Versioned>} editable={editable} share={share} />
            <h4 className="slabel" style={{ margin: 0, padding: 0 }}>
              Boosts and limits
            </h4>
            <Grid fields={QUEUE_WEIGHT_FIELDS.slice(4)} s={s as NumericSettings<Versioned>} editable={editable} />
            <SaveBar s={s} editable={editable} />
          </>
        )}
      </Loader>
    </Section>
  );
}

// ------------------------------------------------------------------ match weights

const FACTOR_PATHS = MATCH_FACTOR_FIELDS.map((f) => f.path);

export function MatchWeightsTab({ editable }: TabProps) {
  const s = useNumericSettings<MatchWeights>('/v1/weights', MATCH_WEIGHT_FIELDS, validateMatchWeights);
  const share = shares(s.draft, FACTOR_PATHS);
  return (
    <Section
      title="Match scoring"
      actions={<Meta data={s.data} />}
      note="Factor weights are normalised by the sum of the factors that apply. Saving creates a new weights version and queues a full re-score; re-ranked suggestions follow within minutes."
    >
      <Loader s={s}>
        {() => (
          <>
            <Grid fields={MATCH_FACTOR_FIELDS} s={s as NumericSettings<Versioned>} editable={editable} share={share} />
            <h4 className="slabel" style={{ margin: 0, padding: 0 }}>
              Tuning
            </h4>
            <Grid fields={MATCH_TUNING_FIELDS} s={s as NumericSettings<Versioned>} editable={editable} />
            <SaveBar s={s} editable={editable} />
          </>
        )}
      </Loader>
    </Section>
  );
}

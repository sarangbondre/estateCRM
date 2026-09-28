'use client';
// The classification + facts form shared by quick add (C-06) and add supply (C-07): side → deal_type → market (Sale
// only) → segment → property_type (filtered by segment), then bhk, area, budget/price by deal type, locality and the
// optional deal tags. Controlled dropdowns only (vocabulary); PRD §5.4, BRD §4.2.
import type { Vocabulary } from '../../lib/vocabulary';
import { inr, sqft } from '../../lib/format';
import { Checkbox, Input, Select, VocabSelect, numOrNull } from '../common';
import {
  budgetLabel,
  DEAL_TAG_FIELDS,
  isStepEnabled,
  marketOptions,
  needsMarket,
  propertyDealTypes,
  propertyTypesFor,
  segmentOptions,
  setClassification,
} from './logic';
import type { ClassStep, RecordForm } from './logic';

export function RecordFields({
  form,
  onChange,
  vocab,
  lockSide,
  disabled,
}: {
  form: RecordForm;
  onChange: (f: RecordForm) => void;
  vocab: Vocabulary | undefined;
  /** Add supply is always Supply. */
  lockSide?: boolean;
  disabled?: boolean;
}) {
  const setStep = (step: ClassStep) => (v: string | null) =>
    onChange({ ...form, ...setClassification(form, step, v, vocab) });
  const off = (step: ClassStep) => Boolean(disabled) || !isStepEnabled(form, step);
  const priceLabel = budgetLabel(form.side, form.dealType);
  const num = (k: 'bhkMin' | 'bhkMax' | 'areaMin' | 'areaMax' | 'priceMin' | 'priceMax') => (v: string) =>
    onChange({ ...form, [k]: numOrNull(v) });

  return (
    <>
      <p className="small muted">
        Classification order (BRD §4.2): side first, then deal type → market (Sale only) → segment → property type.
        Controlled values only.
      </p>
      <div className="form-grid">
        <Select
          label="Side"
          value={form.side}
          options={['Demand', 'Supply']}
          onChange={(v) => setStep('side')(v === 'Demand' || v === 'Supply' ? v : null)}
          required
          disabled={Boolean(disabled) || Boolean(lockSide)}
        />
        <Select
          label="Deal type"
          value={form.dealType}
          options={propertyDealTypes(vocab)}
          onChange={setStep('dealType')}
          required
          disabled={off('dealType')}
        />
        {needsMarket(form.dealType) && (
          <Select
            label="Market"
            value={form.market}
            options={marketOptions(vocab, form.side)}
            onChange={setStep('market')}
            required
            disabled={off('market')}
          />
        )}
        <Select
          label="Segment"
          value={form.segment}
          options={segmentOptions(vocab)}
          onChange={setStep('segment')}
          required
          disabled={off('segment')}
        />
        <Select
          label="Property type"
          value={form.propertyType}
          options={propertyTypesFor(vocab, form.segment)}
          onChange={setStep('propertyType')}
          required
          disabled={off('propertyType')}
          placeholder={form.segment ? 'Choose…' : 'Choose a segment first'}
        />
      </div>
      <div className="form-grid">
        <Input label="BHK min" type="number" inputMode="numeric" min={0} value={form.bhkMin} onChange={num('bhkMin')} />
        <Input label="BHK max" type="number" inputMode="numeric" min={0} value={form.bhkMax} onChange={num('bhkMax')} />
        <Input label="Area min (sq ft)" type="number" inputMode="numeric" min={0} value={form.areaMin} onChange={num('areaMin')} />
        <Input label="Area max (sq ft)" type="number" inputMode="numeric" min={0} value={form.areaMax} onChange={num('areaMax')} />
        <VocabSelect
          field="area_basis"
          label="Area basis"
          value={form.areaBasis}
          onChange={(v) => onChange({ ...form, areaBasis: v })}
          {...(disabled ? { disabled } : {})}
        />
        {priceLabel && (
          <>
            <Input
              label={`${priceLabel} min`}
              type="number"
              inputMode="numeric"
              min={0}
              value={form.priceMin}
              onChange={num('priceMin')}
            />
            <Input
              label={`${priceLabel} max`}
              type="number"
              inputMode="numeric"
              min={0}
              value={form.priceMax}
              onChange={num('priceMax')}
            />
          </>
        )}
        <Input
          label={form.side === 'Demand' ? 'Locality wanted' : 'Locality'}
          value={form.locality}
          onChange={(v) => onChange({ ...form, locality: v })}
          placeholder="e.g. Andheri East"
        />
      </div>
      {(form.areaMin != null || form.areaMax != null || form.priceMin != null || form.priceMax != null) && (
        <p className="small faint">
          {form.areaMin != null || form.areaMax != null ? `${sqft(form.areaMin)} – ${sqft(form.areaMax)}` : ''}
          {priceLabel && (form.priceMin != null || form.priceMax != null)
            ? ` · ${inr(form.priceMin)} – ${inr(form.priceMax)}${priceLabel.includes('month') ? ' / month' : ''}`
            : ''}
        </p>
      )}
      <details>
        <summary className="small">Deal tags (optional)</summary>
        <div className="form-grid">
          {DEAL_TAG_FIELDS.map(([key, field, label]) => (
            <VocabSelect
              key={key}
              field={field}
              label={label}
              value={form.tags[key]}
              onChange={(v) => onChange({ ...form, tags: { ...form.tags, [key]: v } })}
              {...(disabled ? { disabled } : {})}
            />
          ))}
          <Checkbox
            label="Jodi (combined units)"
            checked={form.tags.isJodi === true}
            onChange={(v) => onChange({ ...form, tags: { ...form.tags, isJodi: v ? true : null } })}
          />
        </div>
      </details>
    </>
  );
}

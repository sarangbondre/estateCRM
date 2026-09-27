'use client';
// Building blocks shared by the journeys cards (C-08…C-17) and My queue (P-01): the demand / offer journey header
// (Commercial status, life stage, exit), a user picker over web GET /v1/users (directory view), a labelled text area,
// and the validation list. Journeys reads: getDemandJourney, getOfferJourney.
import type { ReactNode } from 'react';
import type { operations as journeysOps } from '@11e/contracts/journeys';
import type { operations as webOps } from '@11e/contracts/web';
import { useResource } from '../../lib/api';
import type { Resource } from '../../lib/api';
import type { Ok } from '../../lib/contract';
import { Chip, Field } from '../Card';
import { LifeStage, Select } from '../common';

export type DemandJourney = Ok<journeysOps['getDemandJourney']>;
export type OfferJourney = Ok<journeysOps['getOfferJourney']>;
export type User = Ok<webOps['listUsers']>['items'][number];

const enc = encodeURIComponent;

export function useDemandJourney(demand: string | null | undefined): Resource<DemandJourney> {
  return useResource<DemandJourney>(demand ? `/v1/demands/${enc(demand)}/journey` : null);
}

export function useOfferJourney(offer: string | null | undefined): Resource<OfferJourney> {
  return useResource<OfferJourney>(offer ? `/v1/offers/${enc(offer)}/journey` : null);
}

/** Commercial status, life stage and exit chips of a journey (text carries the meaning, not only colour). */
export interface JourneyLike {
  commercialStatus: string;
  lifeCurve?: { stage?: string | null; dayCount?: number | null } | null;
  exit?: { type: string } | null;
}

export function JourneyChips({ journey }: { journey: JourneyLike | undefined }) {
  if (!journey) return null;
  const exit = journey.exit ?? null;
  return (
    <>
      <Chip tone={journey.commercialStatus === 'Inactive' ? 'bad' : 'plain'}>{journey.commercialStatus}</Chip>
      <LifeStage stage={journey.lifeCurve?.stage ?? null} day={journey.lifeCurve?.dayCount ?? null} />
      {exit && <Chip tone={exit.type === 'Dormant' ? 'warn' : 'bad'}>Exited: {exit.type}</Chip>}
    </>
  );
}

/** Active users of the tenant, optionally one role, for pickers (≤ 100, sorted by name by web). */
export function useUsers(role?: string): Resource<Ok<webOps['listUsers']>> {
  return useResource<Ok<webOps['listUsers']>>('/v1/users', { status: 'active', limit: 100, ...(role ? { role } : {}) });
}

export function UserSelect({
  label,
  value,
  onChange,
  role,
  required,
  disabled,
  exclude,
}: {
  label: string;
  value: string | null;
  onChange: (v: string | null) => void;
  role?: string;
  required?: boolean;
  disabled?: boolean;
  exclude?: string;
}) {
  const users = useUsers(role);
  const options = (users.data?.items ?? [])
    .filter((u) => u.userId !== exclude)
    .map((u) => ({ value: u.userId, label: `${u.displayName} · ${u.role}` }));
  return (
    <Select
      label={label}
      value={value}
      onChange={onChange}
      options={options}
      placeholder={users.loading ? 'Loading…' : users.error ? 'Could not load users' : 'Choose…'}
      {...(required ? { required } : {})}
      {...(disabled ? { disabled } : {})}
    />
  );
}

export function TextArea({
  label,
  value,
  onChange,
  maxLength = 2000,
  placeholder,
  disabled,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  maxLength?: number;
  placeholder?: string;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <Field label={label} {...(hint ? { hint } : {})}>
      {(id) => (
        <textarea
          id={id}
          rows={2}
          value={value}
          maxLength={maxLength}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

/** Client-side validation messages (the service validates again). */
export function Problems({ errors }: { errors: readonly string[] }) {
  if (!errors.length) return null;
  return (
    <div role="alert" className="small">
      {errors.map((e) => (
        <div key={e} className="err-note">
          {e}
        </div>
      ))}
    </div>
  );
}

/** A muted explanatory line (what a click will change). */
export function Note({ children }: { children: ReactNode }) {
  return <p className="small muted">{children}</p>;
}

/** Radio group with a visible legend (outcomes, exit types). */
export function Radios<T extends string>({
  legend,
  name,
  value,
  options,
  onChange,
  disabled,
}: {
  legend: string;
  name: string;
  value: T | null;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="row" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="small muted">{legend}</legend>
      {options.map((o) => (
        <label key={o.value} className="row small">
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={value === o.value}
            disabled={disabled}
            onChange={() => onChange(o.value)}
          />{' '}
          {o.label}
        </label>
      ))}
    </fieldset>
  );
}

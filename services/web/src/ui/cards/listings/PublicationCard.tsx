'use client';
// C-12 Publication card (PRD §5.4, US-15, BRD §4.6): the current level, the ceiling and why, the privacy scan with
// flagged spans, the RERA check (A7: "MahaRERA registration pending" in the pilot), a preview of the website card, and
// Private / Anonymous / Public at or below the ceiling. Setting a level needs a click (R-CHAT-1); Supply agent,
// Manager and Admin can set it, others view. listings: getOfferPublication, scanOfferText, setOfferPublication,
// getPublicationSettings; records: getOffer (preview fields only).
import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import type { operations as listingsOps } from '@11e/contracts/listings';
import type { operations as recordsOps } from '@11e/contracts/records';
import { call, useResource } from '../../lib/api';
import type { Body, Ok } from '../../lib/contract';
import { inr, relative, sqft } from '../../lib/format';
import type { CardProps } from '../../shell/types';
import { ActionButton, Card, Chip, Done, ErrorNote, Field, Loading, useAction } from '../Card';
import {
  canSetPublication,
  ceilingWhy,
  findingLabel,
  highlightSpans,
  levelOptions,
  publicationBody,
  reraStatus,
  scanSummary,
} from './logic';
import type { OfferPublicationState, PrivacyScanResult, PublicationLevel, PublicationSettings } from './logic';

type Offer = Ok<recordsOps['getOffer']>;

interface Props {
  offer: string;
  done?: boolean;
  level?: string;
}

const TONE_ICON = { good: '✔', warn: '!', bad: '✗' } as const;
const TONE_CLASS = { good: 'ok', warn: 'wn', bad: 'bd' } as const;

function CheckLine({ tone, children }: { tone: 'good' | 'warn' | 'bad'; children: ReactNode }) {
  return (
    <div className="check">
      <span className={`ic ${TONE_CLASS[tone]}`} aria-hidden="true">
        {TONE_ICON[tone]}
      </span>
      <span>
        <span className="sr-only">{tone === 'good' ? 'Passed: ' : tone === 'warn' ? 'Warning: ' : 'Failed: '}</span>
        {children}
      </span>
    </div>
  );
}

function PublicationCard({ spec, shell, patch }: CardProps<Props>) {
  const code = spec.props.offer;
  const path = `/v1/offers/${encodeURIComponent(code)}/publication`;
  const pub = useResource<Ok<listingsOps['getOfferPublication']>>(code ? path : null);
  const settings = useResource<Ok<listingsOps['getPublicationSettings']>>('/v1/publication-settings');
  const offer = useResource<Offer>(code ? `/v1/offers/${encodeURIComponent(code)}` : null);
  const canSet = canSetPublication(shell.me.role);

  if (!code) return <Card kicker="Publication" title="No offer given" />;
  if (pub.loading && !pub.data)
    return (
      <Card kicker="Publication" title={code}>
        <Loading label="Loading publication" />
      </Card>
    );
  if (!pub.data)
    return (
      <Card kicker="Publication" title={code}>
        <ErrorNote error={pub.error} onRetry={pub.reload} />
      </Card>
    );

  return (
    <PublicationBody
      key={pub.data.version}
      code={code}
      path={path}
      state={pub.data}
      settings={settings.data ?? (settings.error ? null : undefined)}
      offer={offer.data}
      canSet={canSet}
      pilot={!!shell.me.environment?.pilot}
      doneLevel={spec.props.done ? (spec.props.level ?? null) : null}
      onSaved={(s) => {
        patch({ done: true, level: s.level });
        pub.reload();
      }}
    />
  );
}

function PublicationBody({
  code,
  path,
  state,
  settings,
  offer,
  canSet,
  pilot,
  doneLevel,
  onSaved,
}: {
  code: string;
  path: string;
  state: OfferPublicationState;
  settings: PublicationSettings | null | undefined;
  offer: Offer | undefined;
  canSet: boolean;
  pilot: boolean;
  doneLevel: string | null;
  onSaved: (s: OfferPublicationState) => void;
}) {
  const groupId = useId();
  const original = state.publicDescription ?? '';
  const [level, setLevel] = useState<PublicationLevel>(state.level);
  const [text, setText] = useState(original);
  const [scan, setScan] = useState<{ result: PrivacyScanResult; text: string } | null>(
    state.lastScan ? { result: state.lastScan, text: original } : null,
  );
  const unchanged = level === state.level && text === original;
  const saved = doneLevel !== null && doneLevel === state.level && unchanged;

  const options = levelOptions(state);
  const rera = reraStatus(settings, state.rera, pilot);
  // A scan is current only for the exact text shown.
  const currentScan = scan && scan.text === text ? scan.result : null;
  const summary = scanSummary(currentScan);
  const blocked = level !== 'Private' && (currentScan?.result === 'blocked' || rera.tone === 'bad');

  const scanAction = useAction(
    (key) =>
      call<Ok<listingsOps['scanOfferText']>>('POST', `/v1/offers/${encodeURIComponent(code)}/privacy-scan`, {
        body: { text, includePhotos: true } satisfies Body<listingsOps['scanOfferText']>,
        idempotencyKey: key,
      }),
    (r) => setScan({ result: r.data, text }),
  );

  const save = useAction(
    () =>
      call<Ok<listingsOps['setOfferPublication']>>('PUT', path, {
        body: publicationBody(level, state.publicDescription, text) satisfies Body<listingsOps['setOfferPublication']>,
        ifMatch: state.version,
      }),
    (r) => onSaved(r.data ?? { ...state, level }),
  );

  const photoWarnings = (state.photos ?? []).filter((p) => p.publicUse && (p.warnings?.length ?? 0) > 0);
  const publicPhotos = (state.photos ?? []).filter((p) => p.publicUse).length;

  return (
    <Card
      kicker="Publication"
      title={
        <>
          {code}
          {offer?.label || state.label ? <span className="muted"> · {offer?.label ?? state.label}</span> : null}
        </>
      }
      label={`Publication ${code}`}
      chips={
        <>
          <Chip tone={state.level === 'Public' ? 'good' : state.level === 'Anonymous' ? 'supply' : 'plain'}>
            Now: {state.level}
          </Chip>
          {state.publicId && <span className="small faint mono">{state.publicId}</span>}
        </>
      }
      footer={
        canSet ? (
          <>
            {saved && <Done>Set to {state.level}</Done>}
            {save.error !== undefined && <ErrorNote error={save.error} />}
            <span className="grow" />
            {blocked && <span className="small bd">Blocked until the red check is fixed</span>}
            <ActionButton primary onClick={save.run} pending={save.pending} disabled={blocked || unchanged}>
              {level === state.level ? 'Save description' : `Set to ${level}`}
            </ActionButton>
          </>
        ) : (
          <span className="small muted">Your role can view this. Supply agents, Managers and Admins set the level.</span>
        )
      }
    >
      <div>
        <b>Ceiling: {state.ceiling}</b> <span className="small muted">{ceilingWhy(state)}</span>
      </div>
      {state.lastChangeReason && state.lastChangeReason !== 'user' && (
        <p className="small muted" style={{ margin: 0 }}>
          Last changed automatically ({state.lastChangeReason.replace(/_/g, ' ')}) {relative(state.updatedAt)}.
        </p>
      )}

      <div className="pub-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <fieldset style={{ border: 0, padding: 0, margin: 0 }} disabled={!canSet}>
            <legend className="small muted">Publication level</legend>
            {options.map((o) => (
              <div key={o.level} className="row small">
                <input
                  type="radio"
                  id={`${groupId}-${o.level}`}
                  name={`${groupId}-level`}
                  value={o.level}
                  checked={level === o.level}
                  disabled={!o.enabled}
                  aria-describedby={o.reason ? `${groupId}-${o.level}-why` : undefined}
                  onChange={() => setLevel(o.level)}
                />
                <label htmlFor={`${groupId}-${o.level}`} className={o.enabled ? '' : 'faint'}>
                  {o.level}
                  {o.current ? ' (current)' : ''}
                  {!o.enabled ? ' (locked)' : ''}
                </label>
                {o.reason && (
                  <span id={`${groupId}-${o.level}-why`} className="faint">
                    {o.reason}
                  </span>
                )}
              </div>
            ))}
          </fieldset>

          <Field label="Public description" hint={`${text.length} / 2,000 · ${state.descriptionSource === 'staff' ? 'edited by staff' : 'generated'}`}>
            {(id) => (
              <textarea
                id={id}
                value={text}
                maxLength={2000}
                rows={4}
                readOnly={!canSet}
                onChange={(e) => setText(e.target.value)}
              />
            )}
          </Field>
          {canSet && text !== original && (
            <button type="button" className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => setText(original)}>
              Undo text changes
            </button>
          )}
        </div>

        <Preview state={state} level={level} offer={offer} text={text} reraLine={rera.preview} publicPhotos={publicPhotos} />
      </div>

      <div>
        <CheckLine tone={summary.tone}>
          {summary.text}
          {canSet && (
            <>
              {' '}
              <ActionButton small onClick={scanAction.run} pending={scanAction.pending}>
                {currentScan ? 'Scan again' : 'Run privacy scan'}
              </ActionButton>
            </>
          )}
        </CheckLine>
        {scanAction.error !== undefined && <ErrorNote error={scanAction.error} />}
        {currentScan && currentScan.findings.some((f) => f.field === 'description') && (
          <p className="small" style={{ margin: '2px 0 6px 24px', whiteSpace: 'pre-wrap' }} aria-label="Scanned text with flagged parts marked">
            {highlightSpans(text, currentScan.findings).map((s, i) =>
              s.flagged ? (
                <mark key={i} title={s.kinds.map(findingLabel).join(', ')}>
                  {s.text}
                  <span className="sr-only"> ({s.kinds.map(findingLabel).join(', ')})</span>
                </mark>
              ) : (
                <span key={i}>{s.text}</span>
              ),
            )}
          </p>
        )}
        <CheckLine tone={rera.tone}>{rera.text}</CheckLine>
        {photoWarnings.length > 0 && (
          <CheckLine tone="warn">
            {photoWarnings.length} selected photo{photoWarnings.length > 1 ? 's' : ''} may show text (
            {[...new Set(photoWarnings.flatMap((p) => p.warnings ?? []))].map(findingLabel).join(', ')}). Warning only; check
            before making it Public.
          </CheckLine>
        )}
        {state.inputs && state.inputs.hasRealPhotos === false && (
          <CheckLine tone="warn">No real photos yet, so Public is not available.</CheckLine>
        )}
      </div>
    </Card>
  );
}

function offerHeadline(offer: Offer | undefined): string {
  if (!offer) return '';
  const bhk = offer.bhkMin != null ? `${offer.bhkMin}${offer.bhkMax != null && offer.bhkMax !== offer.bhkMin ? `–${offer.bhkMax}` : ''} BHK ` : '';
  const type = offer.propertyTypes?.[0] ?? '';
  const where = offer.locality ?? offer.micromarket?.name ?? offer.city ?? '';
  return `${bhk}${type}${where ? ` in ${where}` : ''}`.trim();
}

function offerPrice(offer: Offer | undefined): string {
  if (!offer) return '';
  if (offer.rentMonthlyInrMin != null) return `${inr(offer.rentMonthlyInrMin)} / month`;
  if (offer.salePriceInrMin != null) return inr(offer.salePriceInrMin);
  return offer.priceText ?? '';
}

/** Website card preview (prototype .webcard), per the level being chosen. */
function Preview({
  state,
  level,
  offer,
  text,
  reraLine,
  publicPhotos,
}: {
  state: OfferPublicationState;
  level: PublicationLevel;
  offer: Offer | undefined;
  text: string;
  reraLine: string;
  publicPhotos: number;
}) {
  const label = offer?.label ?? state.label ?? '';
  const headline = offerHeadline(offer);
  const facts = [offerPrice(offer), offer?.areaSqftMin != null ? `${sqft(offer.areaSqftMin)} ${offer.areaBasis ?? ''}`.trim() : '']
    .filter(Boolean)
    .join(' · ');
  return (
    <div
      className="webcard"
      aria-label="Website preview"
      style={{ border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden', background: 'var(--surface)' }}
    >
      {level === 'Public' && (
        <div className="imgs" aria-hidden="true" style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 3, height: 90 }}>
          <div style={{ background: 'linear-gradient(135deg,var(--accent-soft),var(--demand-soft))' }} />
          <div style={{ background: 'linear-gradient(135deg,var(--demand-soft),var(--surface-2))' }} />
        </div>
      )}
      <div className="c" style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 3, fontSize: 13 }}>
        <span className="small muted">
          {level === 'Private' ? 'Private: not shown on the website' : `${level} listing preview · generated label`}
        </span>
        {level !== 'Private' && (
          <>
            <b>{[label, headline].filter(Boolean).join(' · ') || state.code}</b>
            {facts && <span>{facts}</span>}
            {level === 'Public' ? (
              <span className="small">
                {publicPhotos} photo{publicPhotos === 1 ? '' : 's'}
                {text ? ` · ${text.length > 220 ? `${text.slice(0, 219)}…` : text}` : ''}
              </span>
            ) : (
              <span className="small muted">Details subject to confirmation. No photos.</span>
            )}
            <span className="small faint">{reraLine}</span>
          </>
        )}
      </div>
    </div>
  );
}

export default PublicationCard;

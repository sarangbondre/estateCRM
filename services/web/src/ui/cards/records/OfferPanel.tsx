'use client';
// P-02 Offer panel (PRD §5.4): tabs Overview (status axes from journeys GET /v1/offers/{code}/journey, life curve,
// price / area / labels), Property & other offers (GET /v1/properties/{id}), Sources & sightings, Matches (crm-engine
// matches card), Enquiries, Photos, Activity (journeys call history). "Show contact" reveals the parties (audited).
import { useState } from 'react';
import type { components as R, operations as Records } from '@11e/contracts/records';
import type { components as J, operations as Journeys } from '@11e/contracts/journeys';
import { useResource } from '../../lib/api';
import type { Resource } from '../../lib/api';
import type { Ok } from '../../lib/contract';
import { date, inr, relative, sqft } from '../../lib/format';
import type { PanelProps } from '../../shell/types';
import { Chip } from '../Card';
import { Axis, KV, LifeStage, RecordLink, Tabs } from '../common';
import { cardFor } from '../registry';
import { Loaded, PagedList, RevealContact, SendButton } from './parts';
import { OFFER_COMMERCIAL, OFFER_RECORD_STAGES, PUBLICATION_LEVELS, rangeText } from './logic';
import { CallRow, PropertySummary } from './shared';

type Offer = Ok<Records['getOffer']>;
type Journey = Ok<Journeys['getOfferJourney']>;
type Property = Ok<Records['getProperty']>;

const TABS = ['Overview', 'Property & other offers', 'Sources & sightings', 'Matches', 'Enquiries', 'Photos', 'Activity'] as const;
type Tab = (typeof TABS)[number];

export function OfferPanel({ props, shell }: PanelProps<{ code: string }>) {
  const code = props.code;
  const [tab, setTab] = useState<Tab>('Overview');
  const offer = useResource<Offer>(code ? `/v1/offers/${encodeURIComponent(code)}` : null);
  const journey = useResource<Journey>(code ? `/v1/offers/${encodeURIComponent(code)}/journey` : null);
  const propertyId = offer.data?.propertyId;
  const property = useResource<Property>(propertyId ? `/v1/properties/${encodeURIComponent(propertyId)}` : null);

  if (!code) return <p className="small muted">No offer selected.</p>;
  return (
    <Loaded res={offer} label="Loading offer">
      {(o) => (
        <div>
          <OfferHeader o={o} j={journey.data} />
          {o.status === 'merged' && o.mergedIntoId && (
            <p className="small">
              Merged into{' '}
              <button
                type="button"
                className="btn sm"
                onClick={() => shell.openPanel({ kind: 'offer', title: 'Offer', props: { code: o.mergedIntoId } })}
              >
                the surviving offer
              </button>
            </p>
          )}
          <Tabs tabs={TABS} value={tab} onChange={setTab} label={`${o.code} sections`} />
          <div role="tabpanel" aria-label={tab}>
            {tab === 'Overview' && (
              <Overview o={o} journey={journey} property={property.data} send={shell.send} shell={shell} />
            )}
            {tab === 'Property & other offers' && (
              <Loaded res={property} label="Loading property">
                {(pr) => <PropertySummary p={pr} shell={shell} excludeOfferId={o.id} />}
              </Loaded>
            )}
            {tab === 'Sources & sightings' && <Sources propertyId={o.propertyId} />}
            {tab === 'Matches' && <Matches code={o.code} shell={shell} />}
            {tab === 'Enquiries' && (
              <PagedList<R['schemas']['Enquiry']>
                path="/v1/enquiries"
                query={{ offerId: o.id }}
                empty="No enquiries on this offer yet."
                render={(e) => (
                  <div key={e.id} className="qitem2">
                    <div className="grow">
                      <b className="mono">{e.code}</b>{' '}
                      <span className="small muted">
                        {[e.sourceExport, e.campaignRef, e.listingRef].filter(Boolean).join(' · ') || 'enquiry'}
                      </span>
                    </div>
                    <span className="small muted">{relative(e.receivedAt)}</span>
                  </div>
                )}
              />
            )}
            {tab === 'Photos' && <Photos propertyId={o.propertyId} />}
            {tab === 'Activity' && <Activity subjectId={o.id} o={o} />}
          </div>
        </div>
      )}
    </Loaded>
  );
}

function OfferHeader({ o, j }: { o: Offer; j: Journey | undefined }) {
  const price =
    rangeText(o.salePriceInrMin, o.salePriceInrMax, inr) ??
    (rangeText(o.rentMonthlyInrMin, o.rentMonthlyInrMax, inr) ? `${rangeText(o.rentMonthlyInrMin, o.rentMonthlyInrMax, inr)} / month` : null) ??
    o.priceText ??
    'Price not set';
  return (
    <div className="row">
      <span className="chip supply">Supply offer</span>
      <b style={{ fontSize: 16 }}>{price}</b>
      <span className="small muted">
        {[o.propertyCode, o.label, o.segment, (o.propertyTypes ?? []).join(', ')].filter(Boolean).join(' · ')}
      </span>
      {j && <LifeStage stage={j.lifeCurve?.stage} day={j.lifeCurve?.dayCount ?? null} />}
      {o.outsideLaunchArea && <Chip tone="warn">Outside launch area</Chip>}
      {o.needsReview && <Chip tone="warn">Needs review</Chip>}
    </div>
  );
}

function Overview({
  o,
  journey,
  property,
  send,
  shell,
}: {
  o: Offer;
  journey: Resource<Journey>;
  property: Property | undefined;
  send: (t: string) => void;
  shell: PanelProps['shell'];
}) {
  const j = journey.data;
  const tags = [
    o.saleMode && `sale_mode=${o.saleMode}`,
    o.tenancyStatus && `tenancy_status=${o.tenancyStatus}`,
    o.tenure && `tenure=${o.tenure}`,
    o.agreementForm && `agreement_form=${o.agreementForm}`,
    o.possessionStatus && `possession_status=${o.possessionStatus}`,
    o.furnishing && `furnishing=${o.furnishing}`,
    o.isJodi && 'is_jodi=Yes',
  ].filter(Boolean);
  const parties = (property?.parties ?? []).filter((x) => x.personId);
  return (
    <div>
      <Axis name="Record" steps={OFFER_RECORD_STAGES} current={o.recordStage} />
      {j ? (
        <Axis
          name="Commercial"
          steps={j.commercialStatus === 'Inactive' ? [...OFFER_COMMERCIAL.slice(0, -1), 'Inactive'] : OFFER_COMMERCIAL}
          current={j.commercialStatus}
        />
      ) : journey.error !== undefined ? (
        <p className="small muted">Commercial status is not available right now.</p>
      ) : null}
      <Axis name="Publication" steps={PUBLICATION_LEVELS} current={o.publicationLevel ?? 'Private'} />
      <KV
        rows={[
          [
            'Stored fields',
            <span key="f" className="mono small">
              {[
                `deal_type=${o.dealType}`,
                o.market && `market=${o.market}`,
                o.segment && `segment=${o.segment}`,
                o.propertyTypes?.length && `property_type=${o.propertyTypes.join('|')}`,
                (o.bhkMin ?? o.bhkMax) != null && `bhk=${rangeText(o.bhkMin, o.bhkMax, String)}`,
                ...tags,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>,
          ],
          ['Location', [o.locality, o.micromarket?.name, o.city].filter(Boolean).join(' · ')],
          ['Area', rangeText(o.areaSqftMin, o.areaSqftMax, sqft) && `${rangeText(o.areaSqftMin, o.areaSqftMax, sqft)}${o.areaBasis ? ` ${o.areaBasis.toLowerCase()}` : ''}`],
          ['Sale price', rangeText(o.salePriceInrMin, o.salePriceInrMax, inr)],
          ['Rent', rangeText(o.rentMonthlyInrMin, o.rentMonthlyInrMax, inr) && `${rangeText(o.rentMonthlyInrMin, o.rentMonthlyInrMax, inr)} / month`],
          ['Deposit', o.depositInr != null ? inr(o.depositInr) : null],
          ['Available', o.possessionDate ?? (o.possessionStatus || null)],
          ['Units', o.unitCount != null ? String(o.unitCount) : null],
          ['Sourced for', o.sourcedForDemandCode ? <RecordLink key="d" code={o.sourcedForDemandCode} shell={shell} /> : null],
          [
            'Signals',
            `${o.signals?.enquiryCount ?? 0} enquiries · ${o.signals?.sightingCount ?? 0} sightings${
              j?.signals ? ` · ${j.signals.openMatches ?? 0} open matches` : ''
            }${o.signals?.hasPriceGap ? ' · price gap' : ''}`,
          ],
          ['Queue', j?.queue ? `${j.queue.section.replace(/_/g, ' ')}${j.queue.rank != null ? ` #${j.queue.rank}` : ''}${j.queue.reason ? ` · ${j.queue.reason}` : ''}` : null],
          ['Source', `${o.sourceType}${o.captureMode ? ` · ${o.captureMode.replace('_', ' ')}` : ''}`],
          ['Last seen', o.lastSeenAt ? relative(o.lastSeenAt) : null],
          ['Review', o.needsReview ? o.reviewReason ?? o.reviewReasonCode ?? 'yes' : null],
        ]}
      />
      {o.description && <p className="small">{o.description}</p>}
      <div className="row">
        <SendButton send={send} text={`Called about ${o.code}, confirmed`}>
          Log call
        </SendButton>
        <SendButton send={send} text={`publish ${o.code}`}>
          Publication…
        </SendButton>
        <SendButton send={send} text={`${o.code} is gone`}>
          Retire…
        </SendButton>
      </div>
      <RevealContact
        subjects={[
          ...parties.map((x) => ({ type: 'person' as const, id: x.personId, label: `${x.role}${x.displayName ? ` · ${x.displayName}` : ''}` })),
          ...(property?.hasUnitDetails ? [{ type: 'property' as const, id: o.propertyId, label: 'Unit details' }] : []),
        ]}
      />
      {!parties.length && property && <p className="small faint">No contact is linked to this property.</p>}
    </div>
  );
}

function Sources({ propertyId }: { propertyId: string }) {
  const path = `/v1/properties/${encodeURIComponent(propertyId)}`;
  return (
    <div>
      <PagedList<R['schemas']['SecondSource']>
        title="Other sources"
        path={`${path}/second-sources`}
        empty="No other source advertises this property."
        render={(s) => (
          <div key={s.id} className="qitem2">
            <div className="grow">
              <b>{s.sourceName ?? s.sourceType ?? 'Source'}</b>{' '}
              <span className="small muted">
                {rangeText(s.salePriceInrMin, s.salePriceInrMax, inr) ??
                  (rangeText(s.rentMonthlyInrMin, s.rentMonthlyInrMax, inr) ? `${rangeText(s.rentMonthlyInrMin, s.rentMonthlyInrMax, inr)} / month` : 'no price')}
                {' · seen '}
                {date(s.seenOn)}
              </span>
            </div>
            {s.priceGap && <Chip tone="warn">price gap{s.priceGapPct != null ? ` ${Math.round(s.priceGapPct)}%` : ''}</Chip>}
            <Chip>{s.status}</Chip>
          </div>
        )}
      />
      <PagedList<R['schemas']['Sighting']>
        title="Sightings"
        path={`${path}/sightings`}
        empty="No sightings recorded."
        render={(s) => (
          <div key={s.id} className="qitem2">
            <div className="grow">
              <span>{s.sourceName ?? s.sourceType ?? 'Seen'}</span>{' '}
              <span className="small muted mono">{s.sourceAdCode ?? s.externalRef ?? ''}</span>
            </div>
            <span className="small muted">{date(s.seenOn)}</span>
          </div>
        )}
      />
    </div>
  );
}

function Photos({ propertyId }: { propertyId: string }) {
  return (
    <PagedList<R['schemas']['Photo']>
      path={`/v1/properties/${encodeURIComponent(propertyId)}/photos`}
      empty="No photos yet."
      render={(ph, i) => (
        <figure key={ph.id} style={{ margin: '0 0 10px' }}>
          {ph.status === 'ready' && ph.url ? (
            <img
              src={ph.url}
              alt={`Property photo ${i + 1}${ph.isReal ? '' : ' (not a real photo of the unit)'}`}
              style={{ maxWidth: '100%', borderRadius: 8 }}
              loading="lazy"
            />
          ) : (
            <p className="small muted">Photo {i + 1}: {ph.status.replace('_', ' ')}</p>
          )}
          <figcaption className="small faint">
            {ph.origin.replace('_', ' ')} · {ph.isReal ? 'real' : 'representative'} · {date(ph.createdAt)}
          </figcaption>
        </figure>
      )}
    />
  );
}

function Matches({ code, shell }: { code: string; shell: PanelProps['shell'] }) {
  const C = cardFor('matches');
  return <C spec={{ id: `offer-matches-${code}`, kind: 'matches', props: { offer: code } }} shell={shell} patch={() => {}} />;
}

function Activity({ subjectId, o }: { subjectId: string; o: Offer }) {
  return (
    <div>
      <KV
        rows={[
          ['Created', date(o.createdAt, true)],
          ['Updated', date(o.updatedAt, true)],
          ['First seen', o.firstSeenDate ? date(o.firstSeenDate) : null],
          ['Times seen', o.timesSeen != null ? String(o.timesSeen) : null],
        ]}
      />
      <PagedList<J['schemas']['Call']>
        title="Calls"
        path="/v1/calls"
        query={{ subjectId }}
        empty="No calls logged."
        render={(c) => <CallRow key={c.id} c={c} />}
      />
    </div>
  );
}

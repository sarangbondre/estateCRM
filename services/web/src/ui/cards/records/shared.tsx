'use client';
// Record views reused by several records panels: a property with its offers and parties (P-02 tab, property panel), and
// one call-history row (journeys Call, P-02/P-03/P-04 activity).
import type { components as R, operations as Records } from '@11e/contracts/records';
import type { components as J } from '@11e/contracts/journeys';
import type { Ok } from '../../lib/contract';
import { date, relative, sqft } from '../../lib/format';
import type { ShellActions } from '../../shell/types';
import { Chip } from '../Card';
import { KV, RecordLink } from '../common';
import { List } from './parts';
import { rangeText } from './logic';

type Property = Ok<Records['getProperty']>;

const OUTCOME: Record<J['schemas']['Call']['outcome'], string> = {
  confirmed: 'Confirmed',
  no_answer: 'No answer',
  already_gone: 'Already gone',
  unwilling: 'Unwilling',
};

export function CallRow({ c }: { c: J['schemas']['Call'] }) {
  return (
    <div className="qitem2">
      <div className="grow">
        <b>{OUTCOME[c.outcome] ?? c.outcome}</b>{' '}
        <span className="small muted">
          {c.channel === 'meeting' ? 'meeting' : 'call'} · attempt {c.attemptNo}
          {c.nextCallDate ? ` · next ${date(c.nextCallDate)}` : ''}
        </span>
      </div>
      <span className="small muted">{relative(c.loggedAt)}</span>
    </div>
  );
}

export function PropertySummary({
  p,
  shell,
  excludeOfferId,
}: {
  p: Property;
  shell: ShellActions;
  excludeOfferId?: string;
}) {
  const offers = (p.offers ?? []).filter((o) => o.id !== excludeOfferId);
  return (
    <div>
      <KV
        rows={[
          ['Property', <RecordLink key="c" code={p.code} shell={shell} />],
          ['Segment', p.segment],
          ['Types', <List key="t" values={p.propertyTypes} />],
          ['Location', [p.locality, p.micromarket?.name, p.city].filter(Boolean).join(' · ')],
          [
            'Building',
            p.buildingName ? (
              <span key="b">
                {p.buildingName} <span className="private">PROPOSALS ONLY</span>
              </span>
            ) : null,
          ],
          ['Floor band', p.floorBand ? `${p.floorBand}${p.totalFloors ? ` of ${p.totalFloors}` : ''}` : null],
          ['Area', rangeText(p.areaSqftMin, p.areaSqftMax, sqft)],
          ['BHK', rangeText(p.bhkMin, p.bhkMax, String)],
          ['Amenities', <List key="a" values={p.amenities} />],
          ['Photos', p.photoCount != null ? `${p.photoCount}${p.hasRealPhotos ? ' (real)' : ''}` : null],
          ['Last seen', p.lastSeenAt ? relative(p.lastSeenAt) : null],
        ]}
      />
      {p.outsideLaunchArea && <Chip tone="warn">Outside launch area</Chip>}
      <div className="qh">{excludeOfferId ? 'Other offers on this property' : 'Offers'}</div>
      {offers.length ? (
        offers.slice(0, 50).map((o) => (
          <div key={o.id} className="qitem2">
            <div className="grow">
              <RecordLink code={o.code} shell={shell} /> <span>{o.label}</span>
            </div>
            <Chip>{o.recordStage}</Chip>
            {o.publicationLevel && <Chip>{o.publicationLevel}</Chip>}
          </div>
        ))
      ) : (
        <p className="small muted">No other offers.</p>
      )}
      <div className="qh">Parties</div>
      {(p.parties ?? []).length ? (
        (p.parties ?? []).slice(0, 50).map((x: R['schemas']['PartyLink']) => (
          <div key={`${x.personId}-${x.role}`} className="qitem2">
            <div className="grow">
              <RecordLink code={x.personCode ?? null} shell={shell} /> <span>{x.displayName ?? 'Person'}</span>
            </div>
            <Chip>{x.role}</Chip>
            {x.partyType && <Chip>{x.partyType}</Chip>}
          </div>
        ))
      ) : (
        <p className="small muted">No parties linked.</p>
      )}
    </div>
  );
}

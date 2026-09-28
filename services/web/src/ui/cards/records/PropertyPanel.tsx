'use client';
// Property panel (PRP-…, opened from duplicate candidates, desk items and record links; PRD §5.4 P-02 "Property & other
// offers"): GET /v1/properties/{code} with its offers and parties, "Add supply" and the audited unit / contact reveal.
import type { operations as Records } from '@11e/contracts/records';
import { useResource } from '../../lib/api';
import type { Ok } from '../../lib/contract';
import type { PanelProps } from '../../shell/types';
import { Loaded, RevealContact, SendButton } from './parts';
import { PropertySummary } from './shared';

type Property = Ok<Records['getProperty']>;

export function PropertyPanel({ props, shell }: PanelProps<{ code: string }>) {
  const res = useResource<Property>(props.code ? `/v1/properties/${encodeURIComponent(props.code)}` : null);
  if (!props.code) return <p className="small muted">No property selected.</p>;
  return (
    <Loaded res={res} label="Loading property">
      {(p) => (
        <div>
          <PropertySummary p={p} shell={shell} />
          <div className="row">
            <SendButton send={shell.send} text="/add supply">
              Add supply
            </SendButton>
          </div>
          <RevealContact
            subjects={[
              ...(p.parties ?? [])
                .filter((x) => x.personId)
                .map((x) => ({ type: 'person' as const, id: x.personId, label: `${x.role}${x.displayName ? ` · ${x.displayName}` : ''}` })),
              ...(p.hasUnitDetails ? [{ type: 'property' as const, id: p.id, label: 'Unit details' }] : []),
            ]}
          />
        </div>
      )}
    </Loaded>
  );
}

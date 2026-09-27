// Synthetic event payloads (no real personal data: ids are random, codes are made up).
import { randomUUID } from 'node:crypto';
import type { EventDataMap } from '@11e/contracts/events';

let seq = 0;
type Loose<T> = { [K in keyof T]?: T[K] | undefined };
const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
const next = () => ++seq;

export function offerCreated(over: Loose<EventDataMap['offer.created.v1']> = {}): EventDataMap['offer.created.v1'] {
  const n = next();
  return defined({
    offerId: randomUUID(),
    code: `INV-${String(10_000 + n).padStart(5, '0')}`,
    propertyId: randomUUID(),
    dealType: 'Lease',
    segment: 'Residential',
    propertyTypes: ['Apartment'],
    bhkMin: 2,
    bhkMax: 2,
    areaSqftMin: 650,
    areaSqftMax: 650,
    rentMonthlyInrMin: 65_000,
    rentMonthlyInrMax: 65_000,
    locality: 'Andheri West',
    micromarket: 'Andheri West',
    city: 'Mumbai',
    recordStage: 'Enriched',
    sourceType: 'Channel',
    ...over,
  } as EventDataMap['offer.created.v1']);
}

export function demandCreated(over: Loose<EventDataMap['demand.created.v1']> = {}): EventDataMap['demand.created.v1'] {
  const n = next();
  return defined({
    demandId: randomUUID(),
    code: `DEM-${String(100_000 + n).padStart(6, '0')}`,
    dealTypes: ['Lease'],
    segment: 'Residential',
    propertyTypes: ['Apartment'],
    bhkMin: 2,
    bhkMax: 2,
    rentMonthlyInrMax: 80_000,
    micromarkets: ['Andheri West'],
    localities: ['Andheri West'],
    recordStage: 'Enriched',
    sourceType: 'Channel',
    ...over,
  } as EventDataMap['demand.created.v1']);
}

export function code(prefix: string): string {
  return `${prefix}-${String(1000 + next()).padStart(4, '0')}`;
}

'use client';
// P-05 Project panel (PRD §5.4): GET /v1/projects/{code} — configurations (configuration offers) with units and
// prices, RERA, price-sheet history (GET /v1/projects/{code}/price-sheets) and enquiries (GET /v1/enquiries?projectId=).
import { useState } from 'react';
import type { components as R, operations as Records } from '@11e/contracts/records';
import { useResource } from '../../lib/api';
import type { Ok } from '../../lib/contract';
import { date, inr, relative, sqft } from '../../lib/format';
import type { PanelProps } from '../../shell/types';
import { Chip } from '../Card';
import { KV, RecordLink, Tabs } from '../common';
import { List, Loaded, PagedList } from './parts';
import { rangeText } from './logic';

type Project = Ok<Records['getProject']>;
const TABS = ['Configurations', 'Price sheets', 'Enquiries'] as const;
type Tab = (typeof TABS)[number];

export function ProjectPanel({ props, shell }: PanelProps<{ code: string }>) {
  const [tab, setTab] = useState<Tab>('Configurations');
  const res = useResource<Project>(props.code ? `/v1/projects/${encodeURIComponent(props.code)}` : null);
  if (!props.code) return <p className="small muted">No project selected.</p>;
  return (
    <Loaded res={res} label="Loading project">
      {(p) => {
        const configs = p.configurations ?? [];
        const units = configs.reduce((n, c) => n + (c.unitCount ?? 0), 0);
        return (
          <div>
            <div className="row">
              <b style={{ fontSize: 16 }}>{p.name}</b>
              <span className="mono small muted">{p.code}</span>
              {p.publicationLevel && <Chip>{p.publicationLevel}</Chip>}
              {p.outsideLaunchArea && <Chip tone="warn">Outside launch area</Chip>}
            </div>
            <KV
              rows={[
                ['Developer', p.developerName],
                ['Location', [p.locality, p.micromarket?.name, p.city].filter(Boolean).join(' · ')],
                ['RERA', p.reraNumber ? <span key="r" className="mono">{p.reraNumber}</span> : <span key="r" className="bd">missing</span>],
                ['Possession', p.possessionDate],
                ['Configurations', `${configs.length} · ${units} units`],
                ['Latest price sheet', p.latestPriceSheetDate ? date(p.latestPriceSheetDate) : null],
                ['Amenities', <List key="a" values={p.amenities} />],
              ]}
            />
            <Tabs tabs={TABS} value={tab} onChange={setTab} label={`${p.code} sections`} />
            <div role="tabpanel" aria-label={tab}>
              {tab === 'Configurations' &&
                (configs.length ? (
                  <div className="tw" tabIndex={0} role="region" aria-label="Scrollable table">
                    <table>
                      <thead>
                        <tr>
                          <th>Offer</th>
                          <th>Configuration</th>
                          <th className="n">Area</th>
                          <th className="n">Price</th>
                          <th className="n">Units</th>
                        </tr>
                      </thead>
                      <tbody>
                        {configs.slice(0, 50).map((c: R['schemas']['Offer']) => (
                          <tr key={c.id}>
                            <td>
                              <RecordLink code={c.code} shell={shell} />
                            </td>
                            <td>
                              {(c.propertyTypes ?? []).join(', ') || c.label}
                              {(c.bhkMin ?? c.bhkMax) != null ? ` · ${rangeText(c.bhkMin, c.bhkMax, String)} BHK` : ''}
                            </td>
                            <td className="n">{rangeText(c.areaSqftMin, c.areaSqftMax, sqft) ?? '—'}</td>
                            <td className="n">{rangeText(c.salePriceInrMin, c.salePriceInrMax, inr) ?? '—'}</td>
                            <td className="n">{c.unitCount ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="small muted">No configurations yet.</p>
                ))}
              {tab === 'Price sheets' && (
                <PagedList<R['schemas']['PriceSheet']>
                  path={`/v1/projects/${encodeURIComponent(p.code)}/price-sheets`}
                  empty="No price sheets applied."
                  render={(s) => (
                    <div key={s.id} className="qitem2">
                      <div className="grow">
                        <b>{date(s.sheetDate)}</b>{' '}
                        <span className="small muted">
                          {s.lines?.length ?? 0} lines{s.receivedVia ? ` · via ${s.receivedVia.replace('_', ' ')}` : ''}
                          {s.priceChangedOffers?.length ? ` · ${s.priceChangedOffers.length} price changes` : ''}
                        </span>
                      </div>
                      <span className="small muted">{relative(s.createdAt)}</span>
                    </div>
                  )}
                />
              )}
              {tab === 'Enquiries' && (
                <PagedList<R['schemas']['Enquiry']>
                  path="/v1/enquiries"
                  query={{ projectId: p.id }}
                  empty="No enquiries for this project."
                  render={(e) => (
                    <div key={e.id} className="qitem2">
                      <div className="grow">
                        <b className="mono">{e.code}</b>{' '}
                        <span className="small muted">{[e.campaignRef, e.formRef].filter(Boolean).join(' · ')}</span>
                      </div>
                      <span className="small muted">{relative(e.receivedAt)}</span>
                    </div>
                  )}
                />
              )}
            </div>
          </div>
        );
      }}
    </Loaded>
  );
}

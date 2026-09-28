'use client';
// P-08 Desks panel (PRD §5.4, US-36, FR-DSK-1): tabs Business Desk, Capital Desk, Archive (Equipment), Network (Market
// Participants), Watchlist → GET /v1/desks/{business|capital|archive|network|watchlist}. The Watchlist comes back
// deadlines-within-14-days first (contract); rows open the desk-item panel (C-21), network rows the person panel.
import { useState } from 'react';
import type { components as R } from '@11e/contracts/records';
import { date } from '../../lib/format';
import type { PanelProps } from '../../shell/types';
import { Chip } from '../Card';
import { Tabs } from '../common';
import { PagedList } from './parts';
import { daysUntil, DESK_NOTES, DESK_TAB_LABELS, deskForTab, deskRowPanel } from './logic';
import type { DeskTabLabel } from './logic';

type DeskItem = R['schemas']['DeskItem'];

export function DesksPanel({ props, shell }: PanelProps<{ tab?: string }>) {
  const initial = DESK_TAB_LABELS.find((t) => t === props.tab) ?? 'Business Desk';
  const [tab, setTab] = useState<DeskTabLabel>(initial);
  const desk = deskForTab(tab);
  return (
    <div>
      <Tabs tabs={DESK_TAB_LABELS} value={tab} onChange={setTab} label="Desks" />
      <p className="small muted">{DESK_NOTES[desk]}</p>
      <div role="tabpanel" aria-label={tab}>
        <PagedList<DeskItem>
          key={desk}
          path={`/v1/desks/${desk}`}
          empty="Nothing on this desk."
          render={(it) => {
            const kind = deskRowPanel(desk);
            const days = daysUntil(it.deadlineDate);
            const what = [it.dealTypes?.join(', '), it.sector, it.participantRole, it.signalType, it.partyType]
              .filter(Boolean)
              .join(' · ');
            return (
              <div key={it.id} className="qitem2">
                <div className="grow">
                  <button
                    type="button"
                    className="btn ghost sm mono"
                    onClick={() => shell.openPanel({ kind, title: it.code, props: { code: it.code } })}
                  >
                    {it.code}
                  </button>{' '}
                  <span>{what || it.recordScope}</span>
                  {it.businessDescription && <div className="small muted">{it.businessDescription}</div>}
                  {it.deadlineDate && (
                    <div className={`small ${days != null && days <= 14 ? 'bd' : 'muted'}`}>
                      deadline {date(it.deadlineDate)}
                      {days != null ? (days >= 0 ? ` · in ${days} days` : ` · ${-days} days ago`) : ''}
                    </div>
                  )}
                </div>
                {it.side && <Chip>side {it.side}</Chip>}
                {it.archived && <Chip>archived</Chip>}
              </div>
            );
          }}
        />
      </div>
    </div>
  );
}

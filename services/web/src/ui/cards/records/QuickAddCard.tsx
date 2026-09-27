'use client';
// C-06 Quick add (PRD §5.4, US-04, FR-ENT-1): phone first → POST /v1/quick-add/lookup → dedup result (add a touch to an
// open demand, or a new requirement for the person) → classification in BRD order → POST /v1/quick-add. Prefilled from
// the typed text with intake POST /v1/parse (a failure just leaves the form empty). Nothing is created before "Create".
import { useEffect, useState } from 'react';
import type { components as R, operations as Records } from '@11e/contracts/records';
import type { operations as Intake } from '@11e/contracts/intake';
import { ApiError, call } from '../../lib/api';
import type { Body, Ok } from '../../lib/contract';
import { useVocabulary } from '../../lib/vocabulary';
import type { CardProps } from '../../shell/types';
import { ActionButton, Card, Chip, Done, ErrorNote, Loading, useAction } from '../Card';
import { Checkbox, Input } from '../common';
import { RecordFields } from './RecordFields';
import {
  applyParse,
  buildQuickAddRequest,
  candidatesOf,
  codesFromQuickAdd,
  emptyForm,
  FLAG_LABELS,
  missingRequired,
  quickAddOutcomeText,
  roleAllows,
  ROLES,
} from './logic';
import type { QuickAddChoice, RecordForm, SideValue } from './logic';

export interface QuickAddProps {
  side?: SideValue;
  text?: string;
  done?: boolean;
  outcome?: string;
  message?: string;
  demandCode?: string | null;
  offerCodes?: string[];
}

type Lookup = Ok<Records['quickAddLookup']>;
type QuickAddResult = Ok<Records['quickAdd']>;
type ParseResult = Ok<Intake['parseFreeText']>;
type Candidate = R['schemas']['PropertyCandidate'];

type Step = 'phone' | 'dedup' | 'form';

export function QuickAddCard({ spec, shell, patch }: CardProps<QuickAddProps>) {
  const p = spec.props;
  const { vocab } = useVocabulary();
  const [step, setStep] = useState<Step>('phone');
  // Contact fields live only in this component's memory; never patched into the conversation.
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [sourceDetail, setSourceDetail] = useState('');
  const [duringCall, setDuringCall] = useState(false);
  const [form, setForm] = useState<RecordForm>(() => emptyForm(p.side ?? null));
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [choice, setChoice] = useState<QuickAddChoice>({});
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [parseState, setParseState] = useState<'idle' | 'loading' | 'done' | 'failed'>(p.text ? 'loading' : 'idle');
  const [candidates, setCandidates] = useState<Candidate[]>([]);

  // Prefill from the typed text (US-04 AC2). Parse is side-effect free; failure → continue empty.
  useEffect(() => {
    if (!p.text || p.done) return;
    let live = true;
    const body: Body<Intake['parseFreeText']> = {
      text: p.text,
      sourceType: 'Direct',
      ...(p.side ? { sideHint: p.side } : {}),
    };
    call<ParseResult>('POST', '/v1/parse', { body })
      .then((r) => {
        if (!live) return;
        setParsed(r.data);
        setParseState('done');
        const ph = r.data.contacts?.phones?.[0];
        if (ph) setPhone((cur) => cur || ph);
        const nm = r.data.contacts?.nameCandidate;
        if (nm) setName((cur) => cur || nm);
        const co = r.data.fields?.companyName;
        if (co) setCompany((cur) => cur || co);
        const ref = r.data.fields?.referrerText;
        if (ref) setSourceDetail((cur) => cur || `Referred by ${ref}`);
      })
      .catch(() => live && setParseState('failed'));
    return () => {
      live = false;
    };
  }, [p.text, p.side, p.done]);

  // Apply the suggestion once the vocabulary is there (controlled values only).
  useEffect(() => {
    if (parsed && vocab) setForm((f) => applyParse(f, parsed, vocab));
  }, [parsed, vocab]);

  const doLookup = useAction(
    () =>
      call<Lookup>('POST', '/v1/quick-add/lookup', {
        body: { phone: phone.trim() } satisfies Body<Records['quickAddLookup']>,
      }).then((r) => r.data),
    (r) => {
      setLookup(r);
      setChoice({});
      setStep(r.people?.length ? 'dedup' : 'form');
    },
  );

  const finish = (r: QuickAddResult) => {
    const c = codesFromQuickAdd(r);
    patch({
      done: true,
      outcome: c.outcome,
      message: quickAddOutcomeText(c),
      demandCode: c.demandCode,
      offerCodes: c.offerCodes,
    });
  };
  const onCreateError = (e: unknown) => {
    if (e instanceof ApiError && e.code === 'duplicate-property-suspected') setCandidates(candidatesOf(e.problem));
  };
  const makeCreate = (confirmNew: boolean) => async (key: string) => {
    const body = buildQuickAddRequest(phone, form, choice, {
      name,
      companyName: company,
      sourceDetail,
      duringCall,
      confirmNewDespiteCandidates: confirmNew,
    });
    try {
      const r = await call<QuickAddResult>('POST', '/v1/quick-add', { body, idempotencyKey: key });
      return r.data;
    } catch (e) {
      onCreateError(e);
      throw e;
    }
  };
  // Two actions: "Create new anyway" sends a different body, so it must not reuse the first key (409 key-reused).
  const create = useAction(makeCreate(false), finish);
  const createAnyway = useAction(makeCreate(true), finish);

  const canAct = roleAllows(shell.me.role, ROLES.quickAdd);
  const sideLabel = form.side === 'Supply' ? 'supply' : 'requirement';

  if (p.done) {
    const primary = p.demandCode ?? p.offerCodes?.[0] ?? null;
    return (
      <Card kicker="Quick add" title={p.outcome === 'touch_added' ? 'Touch added' : 'Created'}>
        <Done>{p.message ?? 'Saved'}</Done>
        <div className="row">
          {primary && (
            <button
              type="button"
              className="btn sm"
              onClick={() =>
                shell.openPanel({
                  kind: primary.startsWith('DEM-') ? 'demand' : 'offer',
                  title: primary,
                  props: { code: primary },
                })
              }
            >
              Open {primary}
            </button>
          )}
          {p.demandCode && (
            <button type="button" className="btn sm primary" onClick={() => shell.send(`qualify ${p.demandCode}`)}>
              Qualify
            </button>
          )}
          {!p.demandCode && p.offerCodes?.[0] && (
            <button type="button" className="btn sm" onClick={() => shell.send(`publish ${p.offerCodes?.[0]}`)}>
              Publish
            </button>
          )}
        </div>
      </Card>
    );
  }

  const title =
    step === 'phone' ? 'Step 1 · phone' : step === 'dedup' ? 'Existing client found' : choice.existingPersonId ? 'New requirement for this person' : 'New client';

  const missing = missingRequired(form);
  const touchOnly = Boolean(choice.existingDemandId);

  return (
    <Card
      kicker={`Quick add ${p.side === 'Supply' ? 'supply' : 'requirement'}`}
      title={title}
      chips={parseState === 'loading' ? <Chip>Reading your text…</Chip> : parseState === 'done' ? <Chip tone="good">Prefilled</Chip> : null}
      footer={
        step === 'phone' ? (
          <>
            <span className="grow" />
            <ActionButton primary onClick={doLookup.run} pending={doLookup.pending} disabled={!canAct || phone.trim().length < 6}>
              Look up
            </ActionButton>
          </>
        ) : step === 'form' ? (
          <>
            <button type="button" className="btn" onClick={() => setStep(lookup?.people?.length ? 'dedup' : 'phone')}>
              Back
            </button>
            <span className="grow" />
            {candidates.length > 0 && (
              <ActionButton onClick={createAnyway.run} pending={createAnyway.pending} disabled={!canAct}>
                Create new anyway
              </ActionButton>
            )}
            <ActionButton
              primary
              onClick={create.run}
              pending={create.pending}
              disabled={!canAct || (!touchOnly && missing.length > 0) || candidates.length > 0}
            >
              {touchOnly ? 'Add touch' : `Create ${sideLabel}`}
            </ActionButton>
          </>
        ) : undefined
      }
    >
      <p className="small muted">
        Quick add asks for the phone number first, so an existing client or demand is found instead of recreated.
      </p>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div className="grow">
          <Input label="Phone" type="tel" inputMode="tel" value={phone} onChange={setPhone} required placeholder="+91 98…" />
        </div>
        {step !== 'phone' && (
          <button type="button" className="btn sm" onClick={() => setStep('phone')}>
            Change
          </button>
        )}
      </div>
      {!canAct && <p className="small muted">Your role cannot quick add.</p>}
      {doLookup.error !== undefined && <ErrorNote error={doLookup.error} onRetry={doLookup.run} />}
      {lookup && !lookup.normalised && step !== 'phone' && (
        <p className="small muted">That number did not parse as an Indian / E.164 number; check it.</p>
      )}

      {step === 'dedup' && lookup && (
        <DedupResult
          lookup={lookup}
          onTouch={(personId, demandId) => {
            setChoice({ existingPersonId: personId, existingDemandId: demandId });
            setStep('form');
          }}
          onNew={(personId) => {
            setChoice({ existingPersonId: personId });
            setStep('form');
          }}
          openPanel={(code, kind) => shell.openPanel({ kind, title: code, props: { code } })}
        />
      )}

      {step === 'form' && touchOnly && (
        <p className="small">
          This will add a <b>touch</b> to the existing demand (source Direct, typed in). First-touch credit stays where it is.
        </p>
      )}

      {step === 'form' && !touchOnly && (
        <>
          {!vocab && <Loading label="Loading the controlled lists" />}
          <RecordFields form={form} onChange={setForm} vocab={vocab} />
          <div className="form-grid">
            {!choice.existingPersonId && <Input label="Client name" value={name} onChange={setName} placeholder="optional" />}
            <Input label="Company" value={company} onChange={setCompany} placeholder="optional" />
            <Input label="Source detail" value={sourceDetail} onChange={setSourceDetail} placeholder="e.g. referred by Mr Shah" />
          </div>
          <Checkbox label="Entered during a call (starts at Contacted)" checked={duringCall} onChange={setDuringCall} />
          <p className="small muted">
            Source: Direct, typed in.{' '}
            {form.side === 'Supply' ? 'It is checked for duplicate properties first.' : 'It goes to your To contact queue.'}
          </p>
          {missing.length > 0 && <p className="small muted">Still needed: {missing.join(', ')}.</p>}
        </>
      )}

      {candidates.length > 0 && (
        <div className="box">
          <div className="qh">Possible duplicates of this property</div>
          {candidates.slice(0, 10).map((c) => (
            <div key={c.propertyId} className="qitem2">
              <div className="grow">
                <b>{c.code}</b> <span className="small muted">score {Math.round((c.score ?? 0) * 100)}%</span>
                <div className="small muted">
                  {c.summary ?? ''} {c.reasons?.length ? `· same ${c.reasons.join(', ')}` : ''}
                </div>
              </div>
              <button
                type="button"
                className="btn sm"
                onClick={() => shell.openPanel({ kind: 'property', title: c.code, props: { code: c.code } })}
              >
                Open {c.code}
              </button>
            </div>
          ))}
          <p className="small muted">If it is one of these, open it and add the offer there; otherwise create new anyway.</p>
        </div>
      )}
      {create.error !== undefined && candidates.length === 0 && <ErrorNote error={create.error} />}
      {createAnyway.error !== undefined && <ErrorNote error={createAnyway.error} />}
    </Card>
  );
}

function DedupResult({
  lookup,
  onTouch,
  onNew,
  openPanel,
}: {
  lookup: Lookup;
  onTouch: (personId: string, demandId: string) => void;
  onNew: (personId: string) => void;
  openPanel: (code: string, kind: 'demand' | 'offer' | 'person') => void;
}) {
  return (
    <div>
      {lookup.people.slice(0, 5).map(({ person, openDemands, offers }) => (
        <div key={person.id} className="box">
          <div className="row">
            <button type="button" className="btn ghost sm mono" onClick={() => openPanel(person.code, 'person')}>
              {person.code}
            </button>
            <b>{person.displayName}</b>
            {person.companyName && <span className="small muted">{person.companyName}</span>}
            {(person.flags ?? []).map((f) => (
              <Chip key={f} tone="bad">
                {FLAG_LABELS[f] ?? f}
              </Chip>
            ))}
          </div>
          {(openDemands ?? []).slice(0, 10).map((d) => (
            <div key={d.id} className="qitem2">
              <div className="grow">
                <b>{d.code}</b> <span>{d.label}</span>
                <div className="small muted">
                  {d.touchCount ?? 0} touch{d.touchCount === 1 ? '' : 'es'} · {d.recordStage}
                </div>
              </div>
              <button type="button" className="btn sm primary" onClick={() => onTouch(person.id, d.id)}>
                Add a touch to {d.code} instead
              </button>
            </div>
          ))}
          {(offers ?? []).length > 0 && (
            <p className="small muted">
              Also has offers:{' '}
              {(offers ?? []).slice(0, 5).map((o) => (
                <button key={o.id} type="button" className="btn ghost sm mono" onClick={() => openPanel(o.code, 'offer')}>
                  {o.code}
                </button>
              ))}
            </p>
          )}
          <button type="button" className="btn sm" onClick={() => onNew(person.id)}>
            New requirement for this person
          </button>
        </div>
      ))}
    </div>
  );
}

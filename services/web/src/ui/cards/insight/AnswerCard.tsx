'use client';
// Chat answer (PRD §5.1, C-02 Answer + How I got this, C-03 Table card, R-CHAT-1/2/3): creates the insight
// conversation on first use (createConversation; the id is kept in this card's props), posts the question
// (postMessage) and renders the SSE stream as it arrives — typing indicator until the first token, then text, table,
// dashboard, notice, navigate and proposed-action parts, and "How I got this". Proposed actions run only on click.
import { useEffect, useRef, useState } from 'react';
import { ApiError, describeError, newIdempotencyKey } from '../../lib/api';
import type { CardProps, ShellActions } from '../../shell/types';
import { Card, HowIGotThis } from '../Card';
import { ChatTimeout, ensureConversation, rememberRemote, streamAnswer } from './chat';
import { DashboardSummaryCard } from './Dashboards';
import { applyStreamEvent, chatErrorText, hasContent, howNote, howParts, initialAnswer, viewForPart } from './logic';
import type { AnswerState, MessagePart, NoticePart, TablePart } from './logic';
import { AnswerFigures, DataTable, ExportButton, ProposedAction } from './views';

interface Props {
  question: string;
  /** The UI's local conversation id. */
  conversationId: string;
  /** insight conversation id, once created. */
  remoteId?: string;
  /** Idempotency-Key of the current attempt (a reload replays the stored answer instead of asking again). */
  askKey?: string;
  /** Final answer, kept so the conversation re-renders without asking again. */
  result?: AnswerState | null;
  /** Proposed actions applied from this answer: cardId → result text. */
  actions?: Record<string, string>;
}

function errorFrom(err: unknown): NonNullable<AnswerState['error']> {
  if (err instanceof ChatTimeout) return { code: 'client-timeout', title: chatErrorText('client-timeout'), retryable: true };
  if (err instanceof ApiError) {
    const code = err.status === 429 ? 'rate-limited' : err.code;
    return {
      code,
      title: code === 'rate-limited' || code === 'payload-too-large' ? chatErrorText(code) : describeError(err),
      ...(err.problem.correlationId ? { correlationId: err.problem.correlationId } : {}),
      retryable: err.status !== 403 && err.status !== 413 && err.status !== 400,
    };
  }
  return { code: 'internal', title: describeError(err), retryable: true };
}

function AnswerCard({ spec, shell, patch }: CardProps<Props>) {
  const { question, conversationId } = spec.props;
  const [state, setState] = useState<AnswerState>(spec.props.result ?? initialAnswer);
  const started = useRef(false);
  const mounted = useRef(true);
  const actionsRef = useRef<Record<string, string>>(spec.props.actions ?? {});

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const ask = async (key: string, fresh: boolean) => {
    const set = (s: AnswerState) => mounted.current && setState(s);
    let acc: AnswerState = { ...initialAnswer, status: 'streaming' };
    set(acc);
    try {
      let remoteId = spec.props.remoteId;
      if (remoteId) rememberRemote(conversationId, remoteId);
      else remoteId = await ensureConversation(conversationId, question);
      patch({ remoteId, askKey: key, ...(fresh ? { result: null } : {}) });
      const json = await streamAnswer(remoteId, question, key, (ev) => {
        acc = applyStreamEvent(acc, ev);
        set(acc);
      });
      if (json) acc = json;
      else if (acc.status === 'streaming')
        acc = { ...acc, status: 'error', error: { code: 'stream-incomplete', title: chatErrorText('stream-incomplete'), retryable: true } };
    } catch (err) {
      acc = { ...acc, status: 'error', error: errorFrom(err) };
    }
    set(acc);
    patch({ result: acc });
  };

  useEffect(() => {
    if (started.current || spec.props.result || !question) return;
    started.current = true;
    void ask(spec.props.askKey ?? newIdempotencyKey(), false);
    // Runs once per card: the question is fixed for its lifetime.
  }, []);

  const retry = () => void ask(newIdempotencyKey(), true);
  const streaming = state.status === 'idle' || state.status === 'streaming';
  const how = state.how;

  return (
    <div className="answer" aria-busy={streaming || undefined} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {streaming && !hasContent(state) && (
        <span role="status" className="row small muted">
          <span className="typing" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="sr-only">Working on the answer</span>
        </span>
      )}
      {state.text && (
        <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{state.text}</p>
      )}
      {state.parts.map((p, i) => (
        <Part
          key={p.cardId ?? i}
          part={p}
          shell={shell}
          messageId={state.messageId ?? null}
          doneText={p.cardId ? actionsRef.current[p.cardId] : undefined}
          onActionDone={(id, text) => {
            actionsRef.current = { ...actionsRef.current, [id]: text };
            patch({ actions: actionsRef.current });
          }}
        />
      ))}
      {how && <HowIGotThis parts={howParts(how)} {...(howNote(how, state.fallbackUsed) ? { note: howNote(how, state.fallbackUsed) as string } : {})} />}
      {!how && state.status === 'done' && state.fallbackUsed && (
        <p className="small faint" style={{ margin: 0 }}>
          {howNote(null, true)}
        </p>
      )}
      {state.status === 'error' && state.error && (
        <div role="alert" className="row">
          <span className="err-note">
            {state.error.title}
            {state.error.detail && state.error.detail !== state.error.title ? ` ${state.error.detail}` : ''}
          </span>
          {state.error.retryable && (
            <button type="button" className="btn sm" onClick={retry}>
              Try again
            </button>
          )}
          {state.error.correlationId && <span className="small faint mono">ref {state.error.correlationId.slice(0, 8)}</span>}
        </div>
      )}
      {state.status === 'done' && (
        <span role="status" className="sr-only">
          Answer ready
        </span>
      )}
      {state.status === 'done' && !state.text && state.parts.length === 0 && (
        <p className="small muted" style={{ margin: 0 }}>
          No answer came back. Try rephrasing the question.
        </p>
      )}
    </div>
  );
}

function Part({
  part,
  shell,
  messageId,
  doneText,
  onActionDone,
}: {
  part: MessagePart;
  shell: ShellActions;
  messageId: string | null;
  doneText: string | undefined;
  onActionDone: (cardId: string, text: string) => void;
}) {
  const v = viewForPart(part);
  switch (v.view) {
    case 'answer':
      return <AnswerFigures part={v.part} />;
    case 'table':
      return <TableCard part={v.part} shell={shell} messageId={messageId} />;
    case 'dashboard':
      return (
        <DashboardSummaryCard
          spec={{ id: v.part.cardId, kind: 'dashboard-summary', props: { dashboard: v.part.dashboard, ...(v.part.headline ? { headline: v.part.headline } : {}) } }}
          shell={shell}
          patch={() => {}}
        />
      );
    case 'notice':
      return <Notice part={v.part} shell={shell} />;
    case 'navigate':
      return v.panel ? (
        <div className="row">
          <button type="button" className="btn sm" onClick={() => v.panel && shell.openPanel(v.panel)}>
            Open {v.panel.title}
          </button>
        </div>
      ) : null;
    case 'action':
      return (
        <ProposedAction
          part={v.part}
          shell={shell}
          {...(doneText ? { doneText } : {})}
          onDone={(t) => onActionDone(v.part.cardId, t)}
        />
      );
    default:
      return null;
  }
}

const IN_CHAT_ROWS = 10;

/** C-03 Table card: the first rows, "Open in panel" (P-07) and "Excel". */
function TableCard({ part, shell, messageId }: { part: TablePart; shell: ShellActions; messageId: string | null }) {
  const result = part.result;
  const rows = result.rows ?? [];
  const plan = result.howIGotThis?.plan ?? null;
  const title = result.howIGotThis?.description?.slice(0, 60) || 'Table';
  return (
    <Card
      kicker="Table"
      title={`${rows.length}${result.nextCursor ? '+' : ''} row${rows.length === 1 ? '' : 's'}`}
      footer={
        <>
          <span className="grow" />
          <button
            type="button"
            className="btn sm"
            onClick={() => shell.openPanel({ kind: 'table', title, props: { result, ...(plan ? { plan } : {}), sourceMessageId: messageId } })}
          >
            Open in panel
          </button>
          {part.exportable !== false && <ExportButton plan={plan} shell={shell} sourceMessageId={messageId} />}
        </>
      }
    >
      <DataTable columns={result.columns ?? []} rows={rows.slice(0, IN_CHAT_ROWS)} shell={shell} caption={title} />
      {rows.length > IN_CHAT_ROWS && (
        <p className="small muted" style={{ margin: 0 }}>
          Showing {IN_CHAT_ROWS} of {rows.length}
          {result.nextCursor ? '+' : ''}. Open in panel to see, sort and filter all rows.
        </p>
      )}
    </Card>
  );
}

const NOTICE_TEXT: Record<string, string> = {
  out_of_scope: 'I can only answer from 11 Estates data.',
  model_unavailable_keyword_fallback: 'The AI model is unavailable, so I used the keyword parser.',
  clarify: 'Could you say a little more?',
  no_results: 'Nothing matched.',
  too_many_rows_use_export: 'That is too many rows for chat. Use Excel to export them.',
  not_allowed_for_role: 'Your role cannot see this.',
  export_cap_reached: 'The export limit is reached. Narrow the question.',
};

function Notice({ part, shell }: { part: NoticePart; shell: ShellActions }) {
  const suggestions = (part.suggestions ?? []).slice(0, 5);
  return (
    <div className="note" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span className="small">{part.text || NOTICE_TEXT[part.notice] || part.notice}</span>
      {suggestions.length > 0 && (
        <div className="row">
          {suggestions.map((s) => (
            <button key={s} type="button" className="btn sm" onClick={() => shell.send(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default AnswerCard;

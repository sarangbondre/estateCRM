// Proposals (C-13, US-23, D-11; LLD §4.6): Confirmed-match options, async content snapshot (records + listings),
// async PDF, 14-day share link with a public page, mark sent, client feedback.
import {
  MAX_PHOTOS_PER_OPTION,
  RERA_PENDING,
  SNAPSHOT_MAX_ATTEMPTS,
  buildOption,
  linkExpiryDays,
  preparedForLabel,
} from '../domain/proposals.js';
import type { OfferContent, Snapshot, SnapshotPhoto } from '../domain/proposals.js';
import { rederiveDemand, rederiveOffer } from './derive.js';
import { JourneyError, invalidTransition, notFoundErr, versionMismatchErr } from './errors.js';
import type { ProposalLinkRow, ProposalOptionRow, ProposalRow } from './model.js';
import { audit, notify } from './notify.js';
import type { Integrations, Tx, TxRunner, WorkMessage } from './ports.js';
import { closeItems, openItem, resolveAssignee } from './queue-ops.js';
import { isUuid } from './views.js';

export interface Caller {
  userId: string;
  role: string;
}

const PHOTO_URL_TTL = 600; // 10 min (public page)
const PDF_URL_TTL = 300; // 5 min
const ANY_TENANT = '00000000-0000-0000-0000-000000000000';

export async function proposalByIdOrCode(tx: Tx, idOrCode: string, forUpdate = false): Promise<ProposalRow> {
  const p = isUuid(idOrCode) ? await tx.rows.get('proposals', idOrCode, { forUpdate }) : await tx.rows.byCode('proposals', idOrCode);
  if (!p) throw notFoundErr('proposal');
  if (forUpdate && !isUuid(idOrCode)) return (await tx.rows.get('proposals', p.id, { forUpdate: true })) ?? p;
  return p;
}

export async function proposalView(tx: Tx, p: ProposalRow, options?: ProposalOptionRow[], link?: ProposalLinkRow | null) {
  const opts = options ?? (await tx.q.proposalOptions(p.id));
  const active = link === undefined ? await tx.q.activeLink(p.id) : link;
  const demand = await tx.rows.get('demand_view', p.demand_id);
  return {
    id: p.id,
    code: p.code,
    demandId: p.demand_id,
    ...(demand ? { demandCode: demand.code } : {}),
    status: p.status,
    options: opts.map((o) => ({
      position: o.position,
      matchId: o.match_id,
      offerIds: o.offer_ids.slice(0, 3),
      feedback: (o.feedback === 'maybe' ? null : (o.feedback as 'liked' | null)) ?? null,
      feedbackNote: o.feedback_note,
    })),
    coverNote: p.cover_note,
    pdf: { status: p.pdf_status, generatedAt: p.pdf_generated_at ? p.pdf_generated_at.toISOString() : null },
    activeLink: active
      ? {
          expiresAt: active.expires_at.toISOString(),
          opens: active.open_count,
          lastOpenedAt: active.last_opened_at ? active.last_opened_at.toISOString() : null,
          ...(active.url_hint ? { urlHint: active.url_hint } : {}),
        }
      : null,
    sentAt: p.sent_at ? p.sent_at.toISOString() : null,
    sentChannel: (p.sent_channel as 'Other' | null) ?? null,
    createdBy: p.created_by,
    createdAt: p.created_at.toISOString(),
    version: p.version,
  };
}

/** Every option must be a Confirmed match of the demand in the match projection (409 match-not-confirmed). */
async function validateOptions(tx: Tx, demandId: string, options: readonly { matchId: string; position?: number }[]) {
  const out: { position: number; matchId: string; offerIds: string[] }[] = [];
  const positions = new Set<number>();
  const matches = new Set<string>();
  for (const [i, o] of options.entries()) {
    const position = o.position ?? i + 1;
    if (positions.has(position) || position > 20) throw new JourneyError(400, 'validation-failed', `duplicate or invalid option position ${position}`);
    if (matches.has(o.matchId)) throw new JourneyError(400, 'validation-failed', 'the same match appears twice');
    positions.add(position);
    matches.add(o.matchId);
    const m = await tx.rows.get('match_view', o.matchId);
    if (!m || m.demand_id !== demandId || m.status !== 'Confirmed')
      throw new JourneyError(409, 'match-not-confirmed', `match ${o.matchId} is not a Confirmed match of this demand`);
    out.push({ position, matchId: m.id, offerIds: m.offer_ids.slice(0, 3) });
  }
  return out.sort((a, b) => a.position - b.position);
}

const buildMsg = (tx: Tx, proposalId: string): WorkMessage => ({
  kind: 'build_snapshot',
  tenantId: tx.tenantId,
  proposalId,
  correlationId: tx.correlationId,
});

export async function createProposal(
  tx: Tx,
  caller: Caller,
  body: { demandId: string; options: { matchId: string; position?: number }[]; coverNote?: string | null },
) {
  const demand = await tx.rows.get('demand_view', body.demandId);
  if (!demand) throw notFoundErr('demand');
  const dj = await tx.rows.get('demand_journey', demand.id);
  if (!dj || dj.exit_type || dj.commercial_status === 'Closed') throw invalidTransition('proposals need a live demand');
  const options = await validateOptions(tx, demand.id, body.options);
  const p = await tx.rows.insert('proposals', {
    code: await tx.q.nextCode('PROP'),
    demand_id: demand.id,
    status: 'Preparing',
    cover_note: body.coverNote ?? null,
    created_by: caller.userId,
  });
  await tx.q.replaceProposalOptions(p.id, options);
  await tx.work.send(buildMsg(tx, p.id));
  return proposalView(tx, p, undefined, null);
}

export async function updateProposal(
  tx: Tx,
  idOrCode: string,
  patch: { options?: { matchId: string; position?: number }[]; coverNote?: string | null },
  expectedVersion: number | undefined,
) {
  const p = await proposalByIdOrCode(tx, idOrCode, true);
  if (expectedVersion !== undefined && p.version !== expectedVersion) throw versionMismatchErr();
  if (p.status === 'Sent') throw new JourneyError(409, 'proposal-already-sent', 'a Sent proposal cannot change');
  const next: Partial<ProposalRow> = {};
  if (patch.coverNote !== undefined) {
    next.cover_note = patch.coverNote;
    if (p.snapshot && !patch.options) next.snapshot = { ...(p.snapshot as Snapshot), coverNote: patch.coverNote };
  }
  if (patch.options) {
    await tx.q.replaceProposalOptions(p.id, await validateOptions(tx, p.demand_id, patch.options));
    // Changing options rebuilds the snapshot (LLD §4.6 step 6); the PDF must be generated again.
    Object.assign(next, { status: 'Preparing', snapshot: null, snapshot_at: null, snapshot_attempts: 0, pdf_status: 'none', pdf_path: null, pdf_generated_at: null });
    await tx.work.send(buildMsg(tx, p.id));
  }
  const updated = (await tx.rows.update('proposals', p.id, next)) ?? p;
  return proposalView(tx, updated);
}

const readyForUse = (p: ProposalRow) => {
  if (p.status !== 'Ready' && p.status !== 'Sent')
    throw new JourneyError(409, 'proposal-not-ready', `the proposal is ${p.status}`);
};

export async function requestPdf(tx: Tx, idOrCode: string) {
  const p = await proposalByIdOrCode(tx, idOrCode, true);
  readyForUse(p);
  if (p.pdf_status !== 'queued') {
    await tx.rows.update('proposals', p.id, { pdf_status: 'queued' });
    await tx.work.send({ kind: 'render_pdf', tenantId: tx.tenantId, proposalId: p.id, correlationId: tx.correlationId });
  }
  return { jobId: p.id, status: 'queued' as const, statusUrl: `/v1/proposals/${p.id}/pdf` };
}

export async function pdfStatus(tx: Tx, idOrCode: string) {
  const p = await proposalByIdOrCode(tx, idOrCode);
  return { status: p.pdf_status, path: p.pdf_status === 'ready' ? p.pdf_path : null };
}

export async function pdfResponse(integrations: Integrations, s: { status: ProposalRow['pdf_status']; path: string | null }, now: Date) {
  if (s.status !== 'ready' || !s.path) return { status: s.status, url: null, expiresAt: null };
  return {
    status: s.status,
    url: await integrations.storage.signedUrl(s.path, PDF_URL_TTL),
    expiresAt: new Date(now.getTime() + PDF_URL_TTL * 1000).toISOString(),
  };
}

export async function createShareLink(tx: Tx, caller: Caller, integrations: Integrations, idOrCode: string, days: number | undefined) {
  const p = await proposalByIdOrCode(tx, idOrCode, true);
  readyForUse(p);
  await tx.q.revokeLinks(p.id, tx.now); // a new link revokes the previous one
  const token = integrations.tokens.newToken();
  const expires = new Date(tx.now.getTime() + linkExpiryDays(days) * 86_400_000);
  await tx.rows.insert('proposal_links', {
    proposal_id: p.id,
    token_hash: integrations.tokens.hash(token),
    expires_at: expires,
    created_by: caller.userId,
    url_hint: `…/p/${token.slice(0, 6)}…`,
  });
  await audit(tx, 'proposal.share_link_created', caller.userId, { type: 'proposal', id: p.id }, { code: p.code, days: String(linkExpiryDays(days)) });
  return { url: `${integrations.publicBaseUrl.replace(/\/$/, '')}/p/${token}`, expiresAt: expires.toISOString() };
}

export async function revokeShareLink(tx: Tx, caller: Caller, idOrCode: string) {
  const p = await proposalByIdOrCode(tx, idOrCode, true);
  const n = await tx.q.revokeLinks(p.id, tx.now);
  if (n) await audit(tx, 'proposal.share_link_revoked', caller.userId, { type: 'proposal', id: p.id }, { code: p.code });
}

export async function markSent(tx: Tx, idOrCode: string, body: { channel: 'WhatsApp' | 'Email' | 'In person' | 'Other'; sentAt?: string | null }) {
  const p = await proposalByIdOrCode(tx, idOrCode, true);
  if (p.status === 'Sent') {
    if (p.sent_channel === body.channel) return proposalView(tx, p);
    throw new JourneyError(409, 'proposal-already-sent', 'the proposal was already marked sent');
  }
  readyForUse(p);
  const sentAt = body.sentAt ? new Date(body.sentAt) : tx.now;
  const updated = (await tx.rows.update('proposals', p.id, { status: 'Sent', sent_at: sentAt, sent_channel: body.channel })) ?? p;
  const options = await tx.q.proposalOptions(p.id);
  const demand = await tx.rows.get('demand_view', p.demand_id);
  if (demand && !demand.outside_launch_area) {
    await openItem(tx, {
      section: 'proposals_out',
      subjectType: 'proposal',
      subjectId: p.id,
      subjectCode: p.code,
      demandId: p.demand_id,
      assignee: await resolveAssignee(tx, 'demand', demand.owner_user_id),
      reason: 'proposal_feedback',
      reasonRef: p.code,
      dueAt: sentAt,
    });
  }
  for (const offerId of new Set(options.flatMap((o) => o.offer_ids))) await rederiveOffer(tx, offerId);
  await rederiveDemand(tx, p.demand_id);
  await tx.events.emit(
    'proposal.sent.v1',
    { type: 'proposal', id: p.id },
    { proposalId: p.id, demandId: p.demand_id, matchIds: options.map((o) => o.match_id) },
  );
  return proposalView(tx, updated, options);
}

export async function recordFeedback(
  tx: Tx,
  idOrCode: string,
  body: { options: { position: number; feedback: 'liked' | 'rejected' | 'visit_requested'; note?: string | null }[] },
) {
  const p = await proposalByIdOrCode(tx, idOrCode, true);
  if (p.status !== 'Sent') throw invalidTransition('feedback is recorded on a Sent proposal');
  const options = await tx.q.proposalOptions(p.id);
  const byPos = new Map(options.map((o) => [o.position, o]));
  const verdicts: { matchId: string; verdict: 'liked' | 'rejected' | 'visit_requested' }[] = [];
  for (const f of body.options) {
    const o = byPos.get(f.position);
    if (!o) throw new JourneyError(400, 'validation-failed', `no option at position ${f.position}`);
    await tx.rows.update('proposal_options', o.id, { feedback: f.feedback, feedback_note: f.note ?? null });
    o.feedback = f.feedback;
    o.feedback_note = f.note ?? null;
    verdicts.push({ matchId: o.match_id, verdict: f.feedback });
  }
  await tx.events.emit('proposal.feedback_recorded.v1', { type: 'proposal', id: p.id }, { proposalId: p.id, demandId: p.demand_id, feedback: verdicts });
  if (options.every((o) => o.feedback)) await closeItems(tx, { subjectId: p.id, sections: ['proposals_out'] }, 'done', 'feedback_recorded');
  const fresh = (await tx.rows.get('proposals', p.id)) ?? p;
  return proposalView(tx, fresh, options);
}

// ------------------------------------------------------------------------------------------------ public page

export interface PublicRequest {
  token: string;
  ip: string | null;
  userAgent: string | null;
}

const uaFamily = (ua: string | null) => {
  if (!ua) return null;
  if (/edg\//i.test(ua)) return 'Edge';
  if (/chrome|crios/i.test(ua)) return 'Chrome';
  if (/firefox|fxios/i.test(ua)) return 'Firefox';
  if (/safari/i.test(ua)) return 'Safari';
  return 'Other';
};

/** GET /p/{token}: 404 link-not-found, 410 link-expired; records the open; photos as 10-minute signed URLs. */
export async function publicProposal(runner: TxRunner, integrations: Integrations, req: PublicRequest, correlationId: string) {
  const hash = integrations.tokens.hash(req.token);
  const link = await runner.run(ANY_TENANT, { correlationId }, (tx) => tx.q.linkByHash(hash));
  if (!link) throw new JourneyError(404, 'link-not-found', 'unknown share link');
  const found = await runner.run(link.tenant_id, { correlationId }, async (tx) => {
    if (link.revoked_at || link.expires_at <= tx.now) throw new JourneyError(410, 'link-expired', 'the share link expired or was revoked');
    const p = await tx.rows.get('proposals', link.proposal_id);
    if (!p || !p.snapshot) throw new JourneyError(410, 'link-expired', 'the proposal is no longer available');
    const opened = await tx.q.recordLinkOpen(link, tx.now, req.ip ? integrations.tokens.ipHash(req.ip, tx.now) : null, uaFamily(req.userAgent));
    if (opened.open_count === 1) {
      await notify(tx, p.created_by, {
        kind: 'proposal_opened',
        title: `${p.code} opened by the client`,
        subject: { type: 'proposal', id: p.id, code: p.code },
      });
    }
    return { p, snapshot: p.snapshot as Snapshot };
  });
  const s = found.snapshot;
  const paths = s.options.flatMap((o) => o.photos.map((ph) => ph.path));
  const urls = await integrations.storage.signedUrls(paths, PHOTO_URL_TTL);
  const signed = new Map(paths.map((p, i) => [p, urls[i] as string]));
  return {
    code: found.p.code,
    preparedFor: s.preparedFor,
    agentRera: s.agentRera,
    expiresAt: link.expires_at.toISOString(),
    coverNote: s.coverNote,
    options: s.options.map((o) => ({
      position: o.position,
      title: o.title,
      buildingName: o.buildingName,
      micromarket: o.micromarket,
      locality: o.locality,
      dealType: o.dealType,
      segment: o.segment,
      propertyTypes: o.propertyTypes,
      builtupAreaSqft: o.builtupAreaSqft,
      carpetAreaSqft: o.carpetAreaSqft,
      areaSqftMin: o.areaSqftMin,
      areaSqftMax: o.areaSqftMax,
      areaBasis: o.areaBasis,
      salePriceInrMin: o.salePriceInrMin,
      salePriceInrMax: o.salePriceInrMax,
      rentMonthlyInrMin: o.rentMonthlyInrMin,
      rentMonthlyInrMax: o.rentMonthlyInrMax,
      depositInr: o.depositInr,
      availableFrom: o.availableFrom,
      furnishing: o.furnishing,
      projectRera: o.projectRera,
      photos: o.photos.map((ph) => ({ url: signed.get(ph.path) ?? '', caption: ph.caption })),
      bundleOf: o.bundleOf,
    })),
  };
}
export type PublicProposalView = Awaited<ReturnType<typeof publicProposal>>;

// ------------------------------------------------------------------------------------------------ work items

export interface WorkDeps {
  runner: TxRunner;
  integrations: Integrations;
}

async function failProposal(deps: WorkDeps, msg: WorkMessage, what: 'snapshot' | 'pdf') {
  await deps.runner.run(msg.tenantId, { correlationId: msg.correlationId }, async (tx) => {
    const p = await tx.rows.get('proposals', msg.proposalId, { forUpdate: true });
    if (!p) return;
    if (what === 'snapshot') await tx.rows.update('proposals', p.id, { status: 'Failed' });
    else await tx.rows.update('proposals', p.id, { pdf_status: 'failed' });
    await notify(tx, p.created_by, {
      kind: 'proposal_opened',
      title: `${p.code}: ${what === 'snapshot' ? 'content could not be prepared' : 'PDF could not be generated'}`,
      subject: { type: 'proposal', id: p.id, code: p.code },
    });
  });
}

/**
 * build_snapshot: reads records' existing GET endpoints (service token, R-2) and the MahaRERA number from listings,
 * copies up to 30 photos per option into the private bucket, and freezes an allow-listed snapshot → Ready. After 3
 * failed attempts → Failed with a notification (snapshot-failed).
 */
export async function buildSnapshot(deps: WorkDeps, msg: WorkMessage, attempt: number): Promise<void> {
  const loaded = await deps.runner.run(msg.tenantId, { correlationId: msg.correlationId }, async (tx) => {
    const p = await tx.rows.get('proposals', msg.proposalId);
    if (!p || p.status !== 'Preparing') return null;
    return { p, options: await tx.q.proposalOptions(p.id), demand: await tx.rows.get('demand_view', p.demand_id) };
  });
  if (!loaded) return; // already built (duplicate work item) or superseded
  const { p, options, demand } = loaded;
  const { content, publication, storage } = deps.integrations;
  let snapshot: Snapshot;
  try {
    const rera = await publication.mahareraAgentNumber(msg.tenantId);
    const built = [];
    for (const o of options) {
      const offers: OfferContent[] = [];
      for (const id of o.offer_ids) {
        const offer = await content.offer(msg.tenantId, id);
        if (!offer) throw new Error(`offer ${id} not found in records`);
        offers.push(offer);
      }
      const first = offers[0] as OfferContent;
      const propertyId = typeof first['propertyId'] === 'string' ? (first['propertyId'] as string) : null;
      const property = propertyId ? await content.property(msg.tenantId, propertyId) : null;
      const photos: SnapshotPhoto[] = [];
      if (propertyId) {
        for (const [i, ph] of (await content.photos(msg.tenantId, propertyId)).filter((x) => x.url).slice(0, MAX_PHOTOS_PER_OPTION).entries()) {
          const path = `${msg.tenantId}/${p.id}/${o.position}-${i + 1}.jpg`;
          await storage.copyFromUrl(ph.url as string, path);
          photos.push({ path, caption: ph.caption });
        }
      }
      const projectRera = typeof first['reraNumber'] === 'string' ? (first['reraNumber'] as string) : null;
      built.push(buildOption(o.position, offers, property, photos, projectRera));
    }
    snapshot = {
      preparedFor: demand ? preparedForLabel({ propertyTypes: demand.property_types, micromarkets: demand.micromarkets }) : null,
      agentRera: rera ?? RERA_PENDING,
      coverNote: p.cover_note,
      options: built,
    };
  } catch (err) {
    if (attempt >= SNAPSHOT_MAX_ATTEMPTS) {
      await failProposal(deps, msg, 'snapshot');
      return;
    }
    throw err;
  }
  await deps.runner.run(msg.tenantId, { correlationId: msg.correlationId }, async (tx) => {
    const current = await tx.rows.get('proposals', p.id, { forUpdate: true });
    if (!current || current.status !== 'Preparing') return;
    const now = (await tx.q.proposalOptions(p.id)).map((o) => `${o.position}:${o.match_id}`).join(',');
    if (now !== options.map((o) => `${o.position}:${o.match_id}`).join(',')) return; // options changed: a newer item rebuilds
    await tx.rows.update('proposals', p.id, {
      snapshot: { ...snapshot, coverNote: current.cover_note },
      snapshot_at: tx.now,
      status: 'Ready',
      snapshot_attempts: attempt,
    });
  });
}

/** render_pdf: renders the frozen snapshot and stores journeys-proposals/{tenant}/{proposalId}/{code}.pdf. */
export async function renderPdf(deps: WorkDeps, msg: WorkMessage, attempt: number): Promise<void> {
  const p = await deps.runner.run(msg.tenantId, { correlationId: msg.correlationId }, (tx) => tx.rows.get('proposals', msg.proposalId));
  if (!p || p.pdf_status !== 'queued' || !p.snapshot) return;
  const snapshot = p.snapshot as Snapshot;
  const path = `${msg.tenantId}/${p.id}/${p.code}.pdf`;
  try {
    const photoPaths = snapshot.options.map((o) => o.photos.slice(0, 3).map((ph) => ph.path));
    const flat = photoPaths.flat();
    const urls = await deps.integrations.storage.signedUrls(flat, PHOTO_URL_TTL);
    const photoUrls: Record<number, string[]> = {};
    let k = 0;
    snapshot.options.forEach((o, i) => {
      photoUrls[o.position] = (photoPaths[i] ?? []).map(() => urls[k++] as string);
    });
    const now = new Date();
    const pdf = await deps.integrations.pdf.render({ code: p.code, generatedAt: now, snapshot, photoUrls });
    await deps.integrations.storage.put(path, pdf, 'application/pdf');
  } catch (err) {
    if (attempt >= SNAPSHOT_MAX_ATTEMPTS) {
      await failProposal(deps, msg, 'pdf');
      return;
    }
    throw err;
  }
  await deps.runner.run(msg.tenantId, { correlationId: msg.correlationId }, async (tx) => {
    const current = await tx.rows.get('proposals', p.id, { forUpdate: true });
    if (!current || current.pdf_status !== 'queued') return;
    await tx.rows.update('proposals', p.id, { pdf_status: 'ready', pdf_path: path, pdf_generated_at: tx.now });
  });
}

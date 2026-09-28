// Sourcing requests and proposals (contract tags Sourcing requests, Proposals, Public proposal page).
import type { operations } from '@11e/contracts/journeys';
import type { Service } from '@11e/http';
import {
  createProposal,
  createShareLink,
  markSent,
  pdfResponse,
  pdfStatus,
  proposalByIdOrCode,
  proposalView,
  publicProposal,
  recordFeedback,
  requestPdf,
  revokeShareLink,
  updateProposal,
} from '../application/proposals.js';
import type { PublicProposalView } from '../application/proposals.js';
import { createSourcingRequest, srqByIdOrCode, srqView, updateSourcingRequest } from '../application/sourcing.js';
import type { Http } from './http.js';
import { toHttpError } from './http.js';

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string);

const inr = (v: number | null) => (v === null ? null : `₹${v.toLocaleString('en-IN')}`);

/** Minimal server-rendered page (Accept: text/html); every value is escaped. */
function renderPage(p: PublicProposalView): string {
  const options = p.options
    .map((o) => {
      const facts = [
        o.buildingName,
        [o.locality, o.micromarket].filter(Boolean).join(', '),
        o.carpetAreaSqft ? `${o.carpetAreaSqft} sq ft carpet` : o.areaSqftMin ? `${o.areaSqftMin} sq ft` : null,
        inr(o.salePriceInrMin) ?? (o.rentMonthlyInrMin ? `${inr(o.rentMonthlyInrMin)} / month` : null),
        o.availableFrom ? `Available from ${o.availableFrom}` : null,
        o.furnishing,
        o.projectRera ? `Project RERA ${o.projectRera}` : null,
      ].filter(Boolean);
      const photos = o.photos.map((ph) => `<img src="${esc(ph.url)}" alt="${esc(ph.caption ?? o.title)}" loading="lazy">`).join('');
      return `<section><h2>${esc(o.position)}. ${esc(o.title)}</h2><p>${facts.map(esc).join(' · ')}</p><div class="ph">${photos}</div></section>`;
    })
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Proposal ${esc(p.code)} · 11estates</title>
<style>body{font-family:system-ui,sans-serif;margin:0 auto;max-width:860px;padding:16px;color:#1f2933}h1{color:#0b6e4f}section{border-top:1px solid #d1d5db;padding:12px 0}.ph img{width:220px;height:150px;object-fit:cover;margin:0 8px 8px 0;border-radius:6px}footer{color:#6b7280;font-size:12px;margin-top:24px}</style>
</head><body><h1>11estates</h1><p>Proposal ${esc(p.code)}${p.preparedFor ? ` · ${esc(p.preparedFor)}` : ''}</p>${p.coverNote ? `<p>${esc(p.coverNote)}</p>` : ''}${options}
<footer>11 Estates · ${esc(p.agentRera)} · Details subject to confirmation · Link valid until ${esc(p.expiresAt.slice(0, 10))}</footer></body></html>`;
}

export function registerProposalRoutes(svc: Service<operations>, http: Http): void {
  // ------------------------------------------------------------------------------------------ sourcing requests
  svc.op('createSourcingRequest', async (c, { body }) => {
    const p = http.staff(c, ['Admin', 'Manager', 'Demand agent']);
    return http.post(c, body, 201, (tx) => createSourcingRequest(tx, p, body));
  });

  svc.op('listSourcingRequests', async (c, { query }) => {
    http.staff(c);
    const limit = http.limit(query.limit);
    const after = http.cursor(c, query.cursor);
    const body = await http.tx(c, async (tx) => {
      const rows = await tx.q.listSourcingRequests(
        { status: query.status, assigneeUserId: query.assigneeUserId, requestedBy: query.requestedBy, demandId: query.demandId },
        after,
        limit + 1,
      );
      const page = http.page(rows, limit, (r) => ({ k: r.due_date, id: r.id }));
      return { items: await Promise.all(page.items.map((r) => srqView(tx, r))), nextCursor: page.nextCursor };
    });
    return c.json(body);
  });

  svc.op('getSourcingRequest', async (c, { params }) => {
    http.staff(c);
    return c.json(await http.tx(c, async (tx) => srqView(tx, await srqByIdOrCode(tx, params.idOrCode))));
  });

  svc.op('updateSourcingRequest', async (c, { params, body }) => {
    const p = http.staff(c, ['Admin', 'Manager', 'Demand agent', 'Supply agent']);
    const expected = http.ifMatch(c);
    return c.json(await http.tx(c, (tx) => updateSourcingRequest(tx, p, params.idOrCode, body, expected)));
  });

  // -------------------------------------------------------------------------------------------------- proposals
  svc.op('createProposal', async (c, { body }) => {
    const p = http.staff(c, ['Admin', 'Manager', 'Demand agent']);
    return http.post(c, body, 201, (tx) => createProposal(tx, p, body));
  });

  svc.op('listProposals', async (c, { query }) => {
    http.staff(c);
    const limit = http.limit(query.limit);
    const after = http.cursor(c, query.cursor);
    const body = await http.tx(c, async (tx) => {
      const rows = await tx.q.listProposals({ demandId: query.demandId, status: query.status, createdBy: query.createdBy }, after, limit + 1);
      const page = http.page(rows, limit, (r) => ({ k: r.created_at.toISOString(), id: r.id }));
      return { items: await Promise.all(page.items.map((r) => proposalView(tx, r))), nextCursor: page.nextCursor };
    });
    return c.json(body);
  });

  svc.op('getProposal', async (c, { params }) => {
    http.staff(c);
    return c.json(await http.tx(c, async (tx) => proposalView(tx, await proposalByIdOrCode(tx, params.idOrCode))));
  });

  svc.op('updateProposal', async (c, { params, body }) => {
    http.staff(c, ['Admin', 'Manager', 'Demand agent']);
    const expected = http.ifMatch(c);
    return c.json(await http.tx(c, (tx) => updateProposal(tx, params.idOrCode, body, expected)));
  });

  svc.op('generateProposalPdf', async (c, { params }) => {
    http.staff(c, ['Admin', 'Manager', 'Demand agent']);
    return http.post(c, null, 202, (tx) => requestPdf(tx, params.idOrCode));
  });

  svc.op('getProposalPdf', async (c, { params }) => {
    http.staff(c, ['Admin', 'Manager', 'Demand agent']);
    const s = await http.tx(c, (tx) => pdfStatus(tx, params.idOrCode));
    return c.json(await pdfResponse(http.deps.integrations, s, http.deps.clock.now()));
  });

  svc.op('createProposalShareLink', async (c, { params, body }) => {
    const p = http.staff(c, ['Admin', 'Manager', 'Demand agent']);
    return http.post(c, body ?? null, 201, (tx) => createShareLink(tx, p, http.deps.integrations, params.idOrCode, body?.expiresInDays));
  });

  svc.op('revokeProposalShareLink', async (c, { params }) => {
    const p = http.staff(c, ['Admin', 'Manager', 'Demand agent']);
    await http.tx(c, (tx) => revokeShareLink(tx, p, params.idOrCode));
    return c.body(null, 204);
  });

  svc.op('markProposalSent', async (c, { params, body }) => {
    http.staff(c, ['Admin', 'Manager', 'Demand agent']);
    return http.post(c, body, 200, (tx) => markSent(tx, params.idOrCode, body));
  });

  svc.op('recordProposalFeedback', async (c, { params, body }) => {
    http.staff(c, ['Admin', 'Manager', 'Demand agent']);
    return http.post(c, body, 200, (tx) => recordFeedback(tx, params.idOrCode, body));
  });

  svc.op('getPublicProposal', async (c, { params }) => {
    c.header('cache-control', 'no-store');
    c.header('x-robots-tag', 'noindex');
    c.header('referrer-policy', 'no-referrer');
    let view: PublicProposalView;
    try {
      view = await publicProposal(
        http.runner,
        http.deps.integrations,
        {
          token: params.token,
          ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('x-real-ip') ?? null,
          userAgent: c.req.header('user-agent') ?? null,
        },
        c.get('correlationId'),
      );
    } catch (err) {
      throw toHttpError(err);
    }
    const accept = c.req.header('accept') ?? '';
    if (accept.includes('text/html') && !accept.startsWith('application/json')) return c.html(renderPage(view));
    return c.json(view);
  });
}

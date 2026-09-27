# ADR-0007: Chat-first web app as BFF; actions go to the owning service

- Status: Accepted (Stage 3 approved 2026-09-24)
- Date: 2026-09-24

## Context
- PRD D-9: chat-first UI with cards and panels.
- R-CHAT-1: nothing changes without a click.
- CLAUDE.md: auth at the gateway, sync depth ≤ 2, no shared business-logic service.

## Options
1. **A Next.js web app on Vercel acts as the gateway and BFF.** It handles auth, role checks, routing and card
   composition. The chat is served by insight, which returns proposed actions as structured cards. A click calls the
   owning service directly through the BFF.
2. The chat service executes actions itself. Rejected: it would hold business logic from every domain and create
   deep call chains.

## Decision
Option 1. The BFF also owns users and roles (for JWT claims) and the audit-log sink (consumes `audit.recorded.v1`).
It holds no domain rules.

## Consequences
- Each action runs in exactly one owning service with its own authorisation check.
- The card catalogue (PRD §5.4) maps one to one onto service APIs, which is defined in Stage 4.
- The BFF must stay thin. A review rule: no domain decisions in `web`.

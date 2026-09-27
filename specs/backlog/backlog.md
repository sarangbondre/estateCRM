---
type: Backlog
---

# Backlog

> **Last Updated**: 2026-09-27

---

## Priority Levels

| Level | Meaning |
|-------|---------|
| **P0** | Critical — blocks current phase |
| **P1** | High — address in current/next phase |
| **P2** | Medium — within 2 phases |
| **P3** | Low — nice to have |

**Status**: `open` | `in-progress` | `resolved` | `deferred` | `deprecated`

---

## Bugs

| ID | Title | Priority | Status | Phase | Detail |
|----|-------|----------|--------|-------|--------|
| _(none)_ | | | | | |

## Features

| ID | Title | Priority | Status | Phase | Detail |
|----|-------|----------|--------|-------|--------|
| F-B1 | MahaRERA agent number (mandatory before production listings) | P1 | deferred | Paid gate (REL-01) | docs/06-questionnaire.md A7 |
| F-B2 | Sample WhatsApp extractor file to confirm sender fields | P2 | open | Stage 7 (before INT-11) | PRD OQ-P11 |
| F-B3 | Connectors (WhatsApp n8n, Meta lead ads, website forms) | P3 | deferred | Next phase | BRD OQ-7 |

## Tech Debt

| ID | Title | Priority | Status | Phase | Detail |
|----|-------|----------|--------|-------|--------|
| T-B1 | `person.purged.v1` event for retention propagation | P2 | open | Stage 7 | docs/04-lld/journeys.md §10 G-6 |
| T-B2 | Confirm Supabase standby/failover vs NFR-3 99.9% (possible CR) | P1 | open | Paid gate | docs/04-lld/data-hosting.md §7 |
| T-B3 | Verify pgmq / pg_cron / pg_net on Supabase Free in Mumbai | P1 | open | Provisioning (F-07) | docs/04-lld/data-hosting.md §7 |
| T-B4 | Upgrade TypeScript 6.0 → 7.x when typescript-eslint supports it | P3 | open | Later | docs/06-implementation-rules.md D-8 |

## Enhancements

| ID | Title | Priority | Status | Phase | Detail |
|----|-------|----------|--------|-------|--------|
| _(none)_ | | | | | |

# intake

Turns uploaded files (and typed free text) into validated, classified candidate rows in the standard vocabulary and
hands them to records. It never creates business records itself. Service owner: see CODEOWNERS.
Design: [docs/04-lld/intake.md](../../docs/04-lld/intake.md). Contract:
[contracts/openapi/intake.yaml](../../contracts/openapi/intake.yaml) (31 operations, all implemented; a test asserts
`svc.unimplemented()` is empty).

## Run locally

```bash
pnpm db:start && pnpm db:env > .env.local     # once, from the repo root
pnpm --filter @11e/intake migrate
pnpm --filter @11e/intake dev                 # http://127.0.0.1:3001
pnpm mock records                             # records as a contract mock (vocabulary, micromarkets)
```

Tests: `pnpm --filter @11e/intake test` (local Postgres; Storage is in-memory). Optional suites:

```bash
# real local Supabase Storage API
INTAKE_STORAGE_URL=http://127.0.0.1:54321 INTAKE_STORAGE_SERVICE_KEY=<local service-role key> pnpm --filter @11e/intake test
# 20k-row pilot throughput (INT-11)
INTAKE_PERF=1 pnpm --filter @11e/intake exec vitest run tests/perf
```

## Pipeline

```
POST /v1/uploads ─► browser PUTs the file to Storage (signed URL) ─► POST /inspect ─► q_intake_inspect
  (sha256, sheets, header, strict/mapping, suggested mapping, duplicate check)
  ─► [PUT /mapping] ─► POST /start ─► q_intake_split (NDJSON chunks of 500 pilot / 2,000 paid, anonymised in the
  pilot, migration_map, upload.started.v1) ─► q_intake_chunks × N (validate / translate / rules / redacted model,
  raw rows, row errors, review items, rows.classified.v1 per ≤ 500 rows, review_item.created.v1)
  ─► q_intake_finalize (rejected-rows CSV, upload.completed.v1 | upload.failed.v1)
records pulls the full rows: GET /internal/v1/uploads/{id}/rows?batch= (service token, sub=records).
journeys fetches a row's crm_notes: GET /internal/v1/uploads/{id}/rows/{rowNo}/note (service token, sub=journeys).
```

## Environment

| Variable | Local default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | `INTAKE_DATABASE_URL` from `pnpm db:env` | pooler URL with the `intake_svc` role |
| `CRON_SECRET` | `INTAKE_CRON_SECRET` | must equal Vault `cron_secret_intake` |
| `WEB_URL` / `JWKS_URL` | http://127.0.0.1:3000 | service tokens (R-2) |
| `SERVICE_CREDENTIAL` | — | secret; mints `aud=records` tokens (vocabulary, micromarkets) |
| `RECORDS_URL` | — | records base URL; unset → localities kept as written, vocabulary events retried |
| `STORAGE_URL` / `STORAGE_SERVICE_KEY` | — (`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` also read) | secret key; buckets `intake-uploads`, `intake-rejected` are created on first use |
| `PILOT_MODE` | `true` | anonymise forced on, 20k rows/file, 30-day raw-row retention (CR-005, R-15) |
| `CHUNK_SIZE` | 500 pilot / 2000 paid | rows per chunk |
| `CHUNK_CONCURRENCY` | 5 pilot / 12 paid | live chunk leases per tenant (R-22) |
| `ANONYMISATION_KEY` | dev key (local/test only) | secret; required for a deployed pilot |
| `HF_TOKEN` | — | secret; unset → model unavailable (rows go to review `model_unavailable`) |
| `HF_MODEL` / `HF_ENDPOINT_URL` | Llama-3.1-8B-Instruct / HF router | OpenAI-compatible chat completion endpoint |
| `POOL_MAX` | 3 | capacity plan: 5 pilot, 12 Small, 16 Medium |
| `PORT` | 3001 | local only |

## Owned data

Schema `intake` (owner `intake_owner`, runtime role `intake_svc`): `uploads`, `upload_chunks`, `raw_rows` (monthly
partitions, PII; `crm_notes` holds the row's note text since CR-012), `row_errors`, `row_fingerprints`, `templates`, `review_items` (context is PII-sensitive),
`migration_map_entries`, `vocabulary_cache`, `legacy_terms`, `code_sequences`, and the technical tables
`idempotency_keys`, `outbox`, `processed_events`, `job_leases`. Storage: `intake-uploads` (sources, chunk files) and
`intake-rejected` (rejected-rows CSV, 7 days).

## Queues and events

- Consumes `vocabulary.released.v1` on `q_intake` (fetch from records, checksum, activate newer releases only).
- Work queues: `q_intake_inspect`, `q_intake_split`, `q_intake_chunks`, `q_intake_finalize` (each with a DLQ).
- Publishes: `upload.started.v1`, `rows.classified.v1` (≤ 500 rows, no PII), `upload.completed.v1`, `upload.failed.v1`,
  `review_item.created.v1`, `review_item.resolved.v1`, `audit.recorded.v1`.
- Jobs: `retention-purge`, `expire-idempotency-keys`, `reap-chunk-leases`, `delete-processed-files` (infra/schedules.yaml).

## Privacy

PII never leaves through events or logs. The model only ever receives redacted text (`@11e/redaction`); text that
still fails the post-check is not sent. The row's `building_name` and `floor` (Appendix C since CR-012, both optional:
strict mode accepts the 91-column header and the older 89-column one) are masked in that text first; `crm_notes` is
never sent to the model and never appears in IntakeRow (only the `hasCrmNotes` flag): journeys fetches it from the
note endpoint, and it is purged with the raw rows. In pilot mode every contact is replaced by a consistent fake at split time and
the original file is deleted. Tests use synthetic contacts only (`@11e/testing`) and an intercepting mock for the model.

## Performance (INT-11, local, Apple silicon, local Supabase)

20,000-row synthetic pilot xlsx (6.4 MB, 1% errors, 10% WhatsApp rows), 40 chunks, 5 workers: inspect 0.4 s,
split 3.2 s, chunks 3.8 s, finalize < 0.1 s — **7.3 s end to end** (target ≤ 5 min).

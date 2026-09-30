-- records CR-012 (additive, expand only: older code neither reads nor writes these).
-- 1. The sourcing request an add-supply offer was created for (Offer.sourcingRequestId). Read with the offer only; no
--    query filters on it, so no index.
alter table offers add column if not exists sourcing_request_id uuid;

-- 2. crm_notes hand-off to journeys: one record.note_imported.v1 per (upload, row). Ids only; the note text stays in
--    intake (PII) and journeys fetches it with a service token.
create table if not exists note_imports (
  id uuid primary key,                    -- = aggregateId of record.note_imported.v1
  tenant_id uuid not null,
  upload_id uuid not null,
  row_no integer not null,
  subject_type text not null check (subject_type in ('offer', 'demand', 'person', 'property')),
  subject_id uuid not null,
  created_at timestamptz not null default now()
);
create unique index if not exists note_imports_row on note_imports (tenant_id, upload_id, row_no);  -- once per (upload, row)

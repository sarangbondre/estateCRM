-- CR-012: crm_notes imported from upload rows (record.note_imported.v1). The text is fetched from intake's internal
-- note endpoint with a service token and stored here, marked "imported from upload <code>". One note per upload row.
create table if not exists subject_notes (
  id uuid primary key,
  tenant_id uuid not null,
  subject_type text not null check (subject_type in ('offer', 'demand', 'person', 'property')),
  subject_id uuid not null,
  source text not null default 'upload' check (source in ('upload')),
  upload_id uuid not null,
  upload_code text,
  row_no integer not null check (row_no >= 1),
  label text not null,                     -- "imported from upload <code>"
  note text,                               -- PII possible (nulled by retention-purge)
  imported_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- dedupe per (upload, row): a redelivered event or a replayed work item stores the note once
create unique index if not exists subject_notes_upload_row on subject_notes (tenant_id, upload_id, row_no);
-- a subject's notes, newest first; merges re-point subject_id
create index if not exists subject_notes_subject on subject_notes (tenant_id, subject_id, imported_at desc, id);
-- retention-purge: free text nulled 24 months after the last activity (NFR-18)
create index if not exists subject_notes_purge on subject_notes (tenant_id, updated_at) where note is not null;

comment on column subject_notes.note is 'PII possible';

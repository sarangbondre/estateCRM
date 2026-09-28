-- Indexes for merge re-pointing (LLD §4.11) and the retention purge (LLD §7). Additive only.

-- records.merged.v1 (offer): re-point lease renewals and the offer arrays of options and sourcing requests
create index if not exists lease_renewals_offer on lease_renewals (tenant_id, offer_id);
create index if not exists proposal_options_offers on proposal_options using gin (offer_ids);
create index if not exists srq_offers on sourcing_requests using gin (offer_ids);

-- retention-purge: free-text notes nulled 24 months after the last activity (NFR-18)
create index if not exists calls_notes_purge on calls (tenant_id, updated_at) where notes is not null;
create index if not exists srq_notes_purge on sourcing_requests (tenant_id, updated_at) where notes is not null;
create index if not exists visits_notes_purge on site_visits (tenant_id, updated_at) where notes is not null;
create index if not exists deal_events_note_purge on deal_events (tenant_id, updated_at) where note is not null;
create index if not exists proposals_cover_purge on proposals (tenant_id, updated_at) where cover_note is not null;
-- snapshots kept 24 months (R-15)
create index if not exists proposals_snapshot_purge on proposals (tenant_id, created_at) where snapshot is not null;

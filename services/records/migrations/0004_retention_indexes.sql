-- records: indexes for the retention-purge job (NFR-18, records LLD §7): "source ads whose linked records are all
-- inactive for 24 months" looks up the records created from an ad.
create index if not exists offers_source_ad on offers (tenant_id, source_ad_id) where source_ad_id is not null;
create index if not exists demands_source_ad on demands (tenant_id, source_ad_id) where source_ad_id is not null;
-- enquiries without a person, by age (message purge)
create index if not exists enquiries_retention on enquiries (tenant_id, received_at) where message is not null;

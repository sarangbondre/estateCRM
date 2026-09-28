-- INS-02: distinct property count for the supply "Stock" tile, refreshed nightly by rollup-reconcile (LLD §4.8
-- "count distinct property_id (nightly)"), so the dashboard never scans rm_offer. Additive.
alter table rm_state add column if not exists property_count bigint;
alter table rm_state add column if not exists stock_counted_at timestamptz;

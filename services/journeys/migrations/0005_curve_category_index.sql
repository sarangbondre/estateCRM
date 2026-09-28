-- Threshold changes (PUT /v1/settings/life-curve-thresholds) re-arm the curves of the changed categories for the
-- next nightly run: keyset over (tenant_id, category_key, id).
create index if not exists life_curve_category on life_curve (tenant_id, category_key, id) where frozen = false;

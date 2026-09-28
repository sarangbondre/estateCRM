-- records: lease renewals (R-19, REC-10). The Upcoming offer created from lease_renewal.due.v1 is a second Lease offer
-- on the same property while the current lease runs, so the one-offer-per-deal-type rule excludes renewal offers.
-- Relaxing a unique index is backward compatible (the old code never inserts renewal offers).
create unique index if not exists offers_one_per_deal_type_v2 on offers (tenant_id, property_id, deal_type)
  where status = 'active' and project_id is null and renewal_of_offer_id is null;
drop index if exists offers_one_per_deal_type;

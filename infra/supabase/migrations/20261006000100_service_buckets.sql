-- Storage buckets of the services that don't create their own (only intake does). Without them insight's Excel
-- exports failed with "storage put 400" (EXP-000001..3), and journeys proposal PDFs and records/listings photos would
-- fail the same way. Private except listings-public, which serves the website's listing photos.
insert into storage.buckets (id, name, public) values
  ('insight-exports', 'insight-exports', false),
  ('journeys-proposals', 'journeys-proposals', false),
  ('records-photos', 'records-photos', false),
  ('listings-photos', 'listings-photos', false),
  ('listings-public', 'listings-public', true)
on conflict (id) do nothing;

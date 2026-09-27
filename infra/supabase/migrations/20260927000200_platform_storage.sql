-- Platform storage buckets (F-16, data-hosting §4). Private; accessed with signed URLs or the service role only.
insert into storage.buckets (id, name, public) values ('backups', 'backups', false) on conflict (id) do nothing;

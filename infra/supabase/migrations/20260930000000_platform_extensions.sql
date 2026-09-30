-- Extensions some service schemas use, created by the platform (admin) role so service owner roles never need
-- CREATE on the database. records uses btree_gin (its 0002 migration keeps "create extension if not exists").
create extension if not exists btree_gin with schema extensions;

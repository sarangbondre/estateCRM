-- intake CR-012: the crm_notes text of an upload row, served only to journeys by
-- GET /internal/v1/uploads/{uploadId}/rows/{rowNo}/note (lookup via raw_rows_row). PII-sensitive: never logged, never
-- sent to the model; purged with the raw rows (retention). building_name and floor live in `normalised` like every
-- other IntakeRow field. Additive (expand only): older code never reads or writes the column.
alter table raw_rows add column if not exists crm_notes text;
comment on column raw_rows.crm_notes is 'PII (CR-012): crm_notes text of the row; internal note endpoint only';

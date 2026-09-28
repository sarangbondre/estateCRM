-- INS-03: when the life stage last changed (additive). "Public offers that turned Stale this week" (Appendix A Q6)
-- filters on this instead of updated_at, which moves with every update.
alter table rm_offer add column if not exists life_stage_since timestamptz;
alter table rm_demand add column if not exists life_stage_since timestamptz;
-- Q6: life stage + publication + when the stage was reached
create index if not exists rm_offer_life_since on rm_offer (tenant_id, life_stage, publication_level, life_stage_since);

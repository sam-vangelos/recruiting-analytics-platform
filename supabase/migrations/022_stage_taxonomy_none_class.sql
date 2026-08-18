-- 022 — Widen the stage taxonomy's 3-class check with 'none'.
--
-- 021 bolted funnel_stage onto T05's interviewer-round taxonomy, but the
-- funnel needs rows for stages that are not interview rounds at all
-- (Sourced/outreach labels, Application Review, Offer states, holds,
-- reference checks). stage_class stays NOT NULL so every row makes an
-- explicit call; 'none' says "not an interviewer round" instead of forcing
-- a false rps/technical/onsite that would pollute T05's class counts.
-- Reversible: no row is required to use 'none'; tightening back is a
-- constraint swap once any 'none' rows are reclassified.

alter table recruiting_ops_interview_stage_taxonomy
  drop constraint if exists recruiting_ops_interview_stage_taxonomy_stage_class_check;
alter table recruiting_ops_interview_stage_taxonomy
  add constraint recruiting_ops_interview_stage_taxonomy_stage_class_check
  check (stage_class in ('rps','technical','onsite','none'));

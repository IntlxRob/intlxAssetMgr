-- 011: backfill the four duration columns from calendar time.
--
-- The sync now reads .calendar for these, but every existing row still holds
-- the business-hours figure. metric_set is stored per ticket, so this needs no
-- Zendesk refetch.
--
-- Batched by id so it can be run repeatedly and watched; re-running is
-- harmless because the source values do not move.

UPDATE tickets t
   SET first_resolution_time_minutes =
         (t.metric_set->'first_resolution_time_in_minutes'->>'calendar')::int,
       full_resolution_time_minutes =
         (t.metric_set->'full_resolution_time_in_minutes'->>'calendar')::int,
       agent_wait_time_minutes =
         (t.metric_set->'agent_wait_time_in_minutes'->>'calendar')::int,
       requester_wait_time_minutes =
         (t.metric_set->'requester_wait_time_in_minutes'->>'calendar')::int
 WHERE t.metric_set IS NOT NULL
   AND (
        t.first_resolution_time_minutes
          IS DISTINCT FROM (t.metric_set->'first_resolution_time_in_minutes'->>'calendar')::int
     OR t.full_resolution_time_minutes
          IS DISTINCT FROM (t.metric_set->'full_resolution_time_in_minutes'->>'calendar')::int
     OR t.agent_wait_time_minutes
          IS DISTINCT FROM (t.metric_set->'agent_wait_time_in_minutes'->>'calendar')::int
     OR t.requester_wait_time_minutes
          IS DISTINCT FROM (t.metric_set->'requester_wait_time_in_minutes'->>'calendar')::int
   );

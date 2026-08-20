-- Parameters that shape a definition rather than a target.
--
-- ops_goals is read wholesale by the ops dashboard and rendered as goals, so
-- an aging threshold there would appear as a 7% target with a goal dot. This
-- is the right home for it, and for the next parameter like it.

CREATE TABLE IF NOT EXISTS ops_settings (
  key         TEXT PRIMARY KEY,
  value       NUMERIC NOT NULL,
  label       TEXT NOT NULL,
  note        TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO ops_settings (key, value, label, note) VALUES
('aging_days', 7, 'Aging threshold (days)',
 'A ticket open longer than this and still ours to move counts as aging. Seven is a starting guess - revise it once there is evidence.')
ON CONFLICT (key) DO NOTHING;

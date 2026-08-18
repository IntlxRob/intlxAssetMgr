-- Stage 4l: group membership.
--
-- Membership is a fact about people, not about tickets. Inferring it from
-- activity means an agent who took no tickets this week disappears from their
-- own team - which is the thing a manager most wants to notice.

BEGIN;

CREATE TABLE IF NOT EXISTS group_memberships (
  id          BIGINT PRIMARY KEY,
  agent_id    BIGINT NOT NULL,
  group_id    BIGINT NOT NULL,
  is_default  BOOLEAN NOT NULL DEFAULT false,
  synced_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id, group_id)
);

CREATE INDEX IF NOT EXISTS idx_memberships_group ON group_memberships (group_id);
CREATE INDEX IF NOT EXISTS idx_memberships_agent ON group_memberships (agent_id);

COMMIT;

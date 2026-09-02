-- 017: support level on organizations.
--
-- The old app's Support Level filter. Migration 002 declined to freeze it into
-- a column because the old code read organization_fields.active_subscriptions,
-- which the org sync never wrote, and because a precedence bug resolved
-- "Basic Support, Visualize Premium" to basic.
--
-- Both settled: the data is in organizations.tags, and no organization carries
-- more than one tier tag. The CASE below checks highest-first regardless.
--
-- One organization is tagged visualze-premium, missing the i. Matched rather
-- than dropped: a customer silently absent from every tier filter is worse
-- than tolerating a typo. Worth fixing in Zendesk independently.

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS visualize_tier TEXT;

UPDATE organizations o SET visualize_tier =
  CASE
    WHEN o.tags @> '["visualize-premium"]'::jsonb
      OR o.tags @> '["visualze-premium"]'::jsonb  THEN 'premium'
    WHEN o.tags @> '["visualize-plus"]'::jsonb
      OR o.tags @> '["visualize_plus"]'::jsonb    THEN 'plus'
    WHEN o.tags @> '["visualize-basic"]'::jsonb   THEN 'basic'
  END
WHERE o.tags IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_organizations_visualize_tier
    ON organizations (visualize_tier) WHERE visualize_tier IS NOT NULL;

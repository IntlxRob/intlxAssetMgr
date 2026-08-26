-- 013: resolution targets on calendar time.
--
-- P3 held 1,440 and P4 held 2,400 - three and five *business* days at eight
-- hours each, taken from the "1-3 bus. days" and "5 bus. days" wording in the
-- workflow guide. The Zendesk policy those targets are meant to mirror sets
-- business_hours: false on all sixteen, and intlx sells 24x7 premium support
-- with near-continuous coverage, so calendar is the standard. Three and five
-- calendar days are 4,320 and 7,200.
--
-- P1 and P2 already matched at 240 and 480.

UPDATE sla_targets SET resolution_minutes = 4320 WHERE priority = 'normal';
UPDATE sla_targets SET resolution_minutes = 7200 WHERE priority = 'low';

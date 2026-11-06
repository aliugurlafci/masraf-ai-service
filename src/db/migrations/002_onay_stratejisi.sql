-- Approval strategies (docs/onay-sistemi.md, section 2). A step no longer has a free amount range;
-- each approver has one approval limit (NULL = no limit, the last approver), and the flow's strategy
-- says who sees an amount: 'zincir' every approver up to the one whose limit covers it, 'tek' that
-- approver alone. Existing flows keep their routing as far as the new form allows.

ALTER TABLE dbo.onay_akislari ADD strateji VARCHAR(8) NOT NULL CONSTRAINT df_onay_akislari_strateji DEFAULT 'zincir'
  CONSTRAINT ck_onay_akislari_strateji CHECK (strateji IN ('zincir', 'tek'));
ALTER TABLE dbo.onay_adimlari ADD onay_limiti DECIMAL(18, 2) NULL
  CONSTRAINT ck_onay_adimlari_limit CHECK (onay_limiti IS NULL OR onay_limiti > 0);
GO

-- Every step but the last had an upper limit: each amount went to one approver.
UPDATE a SET strateji = 'tek'
FROM dbo.onay_akislari a
WHERE (SELECT COUNT(*) FROM dbo.onay_adimlari s WHERE s.akis_id = a.id) > 1
  AND NOT EXISTS (
    SELECT 1 FROM dbo.onay_adimlari s
    WHERE s.akis_id = a.id AND s.ust_limit IS NULL
      AND s.sira < (SELECT MAX(x.sira) FROM dbo.onay_adimlari x WHERE x.akis_id = a.id)
  );

-- 'tek' keeps the upper limits. In a chain an approver's limit ends just below the next approver's
-- lower limit. The last approver has no limit.
WITH ordered AS (
  SELECT s.id, a.strateji, s.ust_limit,
    LEAD(s.alt_limit) OVER (PARTITION BY s.akis_id ORDER BY s.sira) AS next_alt
  FROM dbo.onay_adimlari s JOIN dbo.onay_akislari a ON a.id = s.akis_id
)
UPDATE s SET onay_limiti = CASE
    WHEN o.next_alt IS NULL THEN NULL
    WHEN o.strateji = 'tek' THEN CASE WHEN o.ust_limit > 0 THEN o.ust_limit ELSE 0.01 END
    ELSE CASE WHEN o.next_alt - 0.01 > 0 THEN o.next_alt - 0.01 ELSE 0.01 END
  END
FROM dbo.onay_adimlari s JOIN ordered o ON o.id = s.id;

DROP INDEX ix_onay_adimlari_onayci ON dbo.onay_adimlari;
ALTER TABLE dbo.onay_adimlari DROP CONSTRAINT ck_onay_adimlari_aralik;
ALTER TABLE dbo.onay_adimlari DROP CONSTRAINT ck_onay_adimlari_alt;
ALTER TABLE dbo.onay_adimlari DROP COLUMN alt_limit, ust_limit;
-- "Is this user an approver anywhere?" (deactivation guard, user lists).
CREATE INDEX ix_onay_adimlari_onayci ON dbo.onay_adimlari (onayci_id) INCLUDE (akis_id, sira, onay_limiti);

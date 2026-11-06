-- Several named approval flows ("onay stratejisi"). Exactly one is the default; a user may be
-- assigned another one (kullanicilar.onay_akisi_id, NULL = the default). The existing flow becomes
-- the default flow "Genel". See docs/onay-sistemi.md, section 2.

CREATE TABLE dbo.onay_akislari (
  id INT IDENTITY(1, 1) NOT NULL CONSTRAINT pk_onay_akislari PRIMARY KEY,
  ad NVARCHAR(80) COLLATE Turkish_100_CI_AS NOT NULL,
  varsayilan BIT NOT NULL CONSTRAINT df_onay_akislari_varsayilan DEFAULT 0,
  olusturma DATETIME2(3) NOT NULL CONSTRAINT df_onay_akislari_olusturma DEFAULT SYSUTCDATETIME(),
  guncelleme DATETIME2(3) NOT NULL CONSTRAINT df_onay_akislari_guncelleme DEFAULT SYSUTCDATETIME(),
  guncelleyen_id INT NULL CONSTRAINT fk_onay_akislari_guncelleyen REFERENCES dbo.kullanicilar (id)
);
-- Case-insensitive through the column collation.
CREATE UNIQUE INDEX ux_onay_akislari_ad ON dbo.onay_akislari (ad);
-- At most one default here; "at least one" is the service's rule (the default cannot be deleted).
CREATE UNIQUE INDEX ux_onay_akislari_varsayilan ON dbo.onay_akislari (varsayilan) WHERE varsayilan = 1;

INSERT INTO dbo.onay_akislari (ad, varsayilan) VALUES (N'Genel', 1);

-- Keep "last changed by" of the old single flow, which lived only in the audit log.
UPDATE a SET guncelleme = d.tarih, guncelleyen_id = d.kullanici_id
FROM dbo.onay_akislari a
CROSS APPLY (
  SELECT TOP (1) tarih, kullanici_id FROM dbo.denetim_kayitlari
  WHERE islem IN ('onay_akisi_guncellendi', 'ilk_yonetici') ORDER BY tarih DESC, id DESC
) d;

ALTER TABLE dbo.onay_adimlari ADD akis_id INT NULL;
ALTER TABLE dbo.kullanicilar ADD onay_akisi_id INT NULL;
GO

UPDATE dbo.onay_adimlari SET akis_id = (SELECT id FROM dbo.onay_akislari WHERE varsayilan = 1);
ALTER TABLE dbo.onay_adimlari ALTER COLUMN akis_id INT NOT NULL;
ALTER TABLE dbo.onay_adimlari ADD CONSTRAINT fk_onay_adimlari_akis FOREIGN KEY (akis_id) REFERENCES dbo.onay_akislari (id) ON DELETE CASCADE;

-- Order and approver are unique within a flow, no longer across the company.
DROP INDEX ux_onay_adimlari_sira ON dbo.onay_adimlari;
DROP INDEX ux_onay_adimlari_onayci ON dbo.onay_adimlari;
CREATE UNIQUE INDEX ux_onay_adimlari_sira ON dbo.onay_adimlari (akis_id, sira);
CREATE UNIQUE INDEX ux_onay_adimlari_onayci ON dbo.onay_adimlari (akis_id, onayci_id);
-- "Is this user an approver anywhere?" (deactivation guard, user lists).
CREATE INDEX ix_onay_adimlari_onayci ON dbo.onay_adimlari (onayci_id) INCLUDE (akis_id, sira, alt_limit, ust_limit);

ALTER TABLE dbo.kullanicilar ADD CONSTRAINT fk_kullanicilar_onay_akisi FOREIGN KEY (onay_akisi_id) REFERENCES dbo.onay_akislari (id);
CREATE INDEX ix_kullanicilar_onay_akisi ON dbo.kullanicilar (onay_akisi_id) WHERE onay_akisi_id IS NOT NULL;

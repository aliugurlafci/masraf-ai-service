-- Several invoices per expense form (docs/onay-sistemi.md, section 3). The single
-- masraf_formlari.fatura_kayit_id moves to form_faturalari. `aktif` turns 0 when the form is
-- cancelled: the cancelled form keeps showing its invoices, and they become free for another form.

CREATE TABLE dbo.form_faturalari (
  form_id INT NOT NULL CONSTRAINT fk_form_faturalari_form REFERENCES dbo.masraf_formlari (id) ON DELETE CASCADE,
  kayit_id VARCHAR(24) NOT NULL CONSTRAINT fk_form_faturalari_kayit REFERENCES dbo.fatura_kayitlari (id),
  -- Order the invoices were added in, from 1.
  sira INT NOT NULL CONSTRAINT ck_form_faturalari_sira CHECK (sira >= 1),
  aktif BIT NOT NULL CONSTRAINT df_form_faturalari_aktif DEFAULT 1,
  CONSTRAINT pk_form_faturalari PRIMARY KEY (form_id, kayit_id)
);
CREATE UNIQUE INDEX ux_form_faturalari_sira ON dbo.form_faturalari (form_id, sira);
-- One invoice, one live form: an invoice cannot be claimed twice.
CREATE UNIQUE INDEX ux_form_faturalari_kayit ON dbo.form_faturalari (kayit_id) WHERE aktif = 1;
-- Access checks find the forms of an invoice, cancelled ones included.
CREATE INDEX ix_form_faturalari_kayit ON dbo.form_faturalari (kayit_id) INCLUDE (aktif);

INSERT INTO dbo.form_faturalari (form_id, kayit_id, sira, aktif)
SELECT id, fatura_kayit_id, 1, CASE WHEN durum = 'iptal' THEN 0 ELSE 1 END
FROM dbo.masraf_formlari
WHERE fatura_kayit_id IS NOT NULL;

DROP INDEX ux_masraf_formlari_fatura ON dbo.masraf_formlari;
ALTER TABLE dbo.masraf_formlari DROP CONSTRAINT fk_masraf_formlari_fatura;
ALTER TABLE dbo.masraf_formlari DROP COLUMN fatura_kayit_id;

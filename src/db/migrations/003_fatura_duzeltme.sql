-- Invoice corrections and the duplicate-invoice guard (docs/onay-sistemi.md, section 3, "Fatura
-- bilgileri, düzeltme ve gönderim kontrolleri").
--
-- duzeltme: the user's correction of the read invoice on this form only, the whole invoice JSON
-- ({ fatura, kalemler }); NULL = no correction, the read result in fatura_kayitlari.sonuc holds.
-- mukerrer_anahtari: the duplicate key of the invoice's effective data (correction or read result),
-- computed by the application on every write (src/invoice/effective.ts). NULL when the invoice has no
-- invoice number. A binary collation keeps comparisons exact: the application already normalises the
-- key, and a Turkish case-insensitive collation would treat I/ı and İ/i as equal.
--
-- Existing rows get their keys when the server starts (fillDuplicateKeys in src/expenses/forms.ts).

ALTER TABLE dbo.form_faturalari ADD
  duzeltme NVARCHAR(MAX) NULL CONSTRAINT ck_form_faturalari_duzeltme CHECK (duzeltme IS NULL OR ISJSON(duzeltme) = 1),
  mukerrer_anahtari NVARCHAR(450) COLLATE Latin1_General_100_BIN2 NULL;
GO

-- Not unique: two drafts may hold the same key; sending is refused by the application, which
-- serialises sends with an application lock (sp_getapplock) so two forms cannot pass at once.
CREATE INDEX ix_form_faturalari_mukerrer ON dbo.form_faturalari (mukerrer_anahtari) INCLUDE (form_id)
  WHERE aktif = 1 AND mukerrer_anahtari IS NOT NULL;

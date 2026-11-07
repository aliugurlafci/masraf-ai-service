-- In-app notifications, the outgoing mail box, the users' mail preference and approval reminders
-- (docs/onay-sistemi.md, sections 4 and 7). Notifications and mails are written in the transaction of
-- the action that causes them.

ALTER TABLE dbo.kullanicilar ADD mail_bildirim BIT NOT NULL CONSTRAINT df_kullanicilar_mail_bildirim DEFAULT 1;
-- When the approver of this step was last reminded; NULL = never.
ALTER TABLE dbo.form_onaylari ADD son_hatirlatma DATETIME2(3) NULL;
GO

CREATE TABLE dbo.bildirimler (
  id INT IDENTITY(1, 1) NOT NULL CONSTRAINT pk_bildirimler PRIMARY KEY,
  kullanici_id INT NOT NULL CONSTRAINT fk_bildirimler_kullanici REFERENCES dbo.kullanicilar (id),
  tur VARCHAR(20) NOT NULL CONSTRAINT ck_bildirimler_tur
    CHECK (tur IN ('onay_bekliyor', 'hatirlatma', 'devredildi', 'onaylandi', 'reddedildi', 'odendi', 'odeme_bekliyor')),
  form_id INT NULL CONSTRAINT fk_bildirimler_form REFERENCES dbo.masraf_formlari (id) ON DELETE CASCADE,
  baslik NVARCHAR(200) COLLATE Turkish_100_CI_AS NOT NULL,
  mesaj NVARCHAR(1000) COLLATE Turkish_100_CI_AS NOT NULL,
  olusturma DATETIME2(3) NOT NULL CONSTRAINT df_bildirimler_olusturma DEFAULT SYSUTCDATETIME(),
  -- NULL = not read yet.
  okunma DATETIME2(3) NULL
);
-- A user's notifications, newest first.
CREATE INDEX ix_bildirimler_kullanici ON dbo.bildirimler (kullanici_id, olusturma DESC, id DESC) INCLUDE (okunma);
-- The unread badge.
CREATE INDEX ix_bildirimler_okunmamis ON dbo.bildirimler (kullanici_id) WHERE okunma IS NULL;

CREATE TABLE dbo.eposta_kutusu (
  id INT IDENTITY(1, 1) NOT NULL CONSTRAINT pk_eposta_kutusu PRIMARY KEY,
  -- NULL = a test mail sent to an address an administrator typed.
  alici_id INT NULL CONSTRAINT fk_eposta_kutusu_alici REFERENCES dbo.kullanicilar (id),
  adres NVARCHAR(254) NOT NULL,
  konu NVARCHAR(200) NOT NULL,
  metin NVARCHAR(MAX) NOT NULL,
  html NVARCHAR(MAX) NOT NULL,
  -- The approval document is rendered from the form when the mail is sent; it is never stored.
  ek_turu VARCHAR(16) NULL CONSTRAINT ck_eposta_kutusu_ek CHECK (ek_turu IS NULL OR ek_turu = 'masraf_pdf'),
  form_id INT NULL CONSTRAINT fk_eposta_kutusu_form REFERENCES dbo.masraf_formlari (id) ON DELETE CASCADE,
  durum VARCHAR(12) NOT NULL CONSTRAINT df_eposta_kutusu_durum DEFAULT 'bekliyor'
    CONSTRAINT ck_eposta_kutusu_durum CHECK (durum IN ('bekliyor', 'gonderildi', 'hata', 'atlandi')),
  deneme INT NOT NULL CONSTRAINT df_eposta_kutusu_deneme DEFAULT 0 CONSTRAINT ck_eposta_kutusu_deneme CHECK (deneme >= 0),
  -- A short, cleaned message: never the SMTP password or the mail body.
  son_hata NVARCHAR(500) NULL,
  sonraki_deneme DATETIME2(3) NULL,
  olusturma DATETIME2(3) NOT NULL CONSTRAINT df_eposta_kutusu_olusturma DEFAULT SYSUTCDATETIME(),
  gonderim DATETIME2(3) NULL,
  CONSTRAINT ck_eposta_kutusu_ek_form CHECK (ek_turu IS NULL OR form_id IS NOT NULL)
);
-- The outbox job picks the mails that are due: durum = 'bekliyor' AND sonraki_deneme <= now.
CREATE INDEX ix_eposta_kutusu_sira ON dbo.eposta_kutusu (durum, sonraki_deneme, id);
-- The administrators' list, newest first.
CREATE INDEX ix_eposta_kutusu_olusturma ON dbo.eposta_kutusu (olusturma DESC, id DESC);

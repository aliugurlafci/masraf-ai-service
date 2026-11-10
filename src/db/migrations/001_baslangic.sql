-- The whole schema: users and sessions, approval flows, invoice records, expense forms and the files
-- still being read, notifications and mails, definition lists and receipt fields. See
-- docs/onay-sistemi.md for the rules these tables enforce. Every change from here on goes in a new
-- numbered file (002_….sql); this one is never edited once a database has run it.
--
-- Names, titles and codes use the Turkish case-insensitive collation: uniqueness ignores case with
-- Turkish rules (i/İ, ı/I), as the application compares them.

-- ---------------------------------------------------------------------------------------------------
-- Users and sessions

CREATE TABLE dbo.kullanicilar (
  id INT IDENTITY(1, 1) NOT NULL CONSTRAINT pk_kullanicilar PRIMARY KEY,
  -- Stored lower-case; uniqueness is checked on this exact value.
  eposta NVARCHAR(254) NOT NULL,
  ad_soyad NVARCHAR(120) COLLATE Turkish_100_CI_AS NOT NULL,
  rol VARCHAR(16) NOT NULL CONSTRAINT ck_kullanicilar_rol CHECK (rol IN ('calisan', 'muhasebe', 'yonetici')),
  departman NVARCHAR(80) COLLATE Turkish_100_CI_AS NULL,
  sifre_ozeti VARCHAR(256) NOT NULL,
  aktif BIT NOT NULL CONSTRAINT df_kullanicilar_aktif DEFAULT 1,
  sifre_degismeli BIT NOT NULL CONSTRAINT df_kullanicilar_sifre_degismeli DEFAULT 0,
  -- Whether the user gets notification mails (the in-app notifications always come).
  mail_bildirim BIT NOT NULL CONSTRAINT df_kullanicilar_mail_bildirim DEFAULT 1,
  olusturma DATETIME2(3) NOT NULL CONSTRAINT df_kullanicilar_olusturma DEFAULT SYSUTCDATETIME(),
  guncelleme DATETIME2(3) NOT NULL CONSTRAINT df_kullanicilar_guncelleme DEFAULT SYSUTCDATETIME(),
  son_giris DATETIME2(3) NULL,
  -- The approval flow the user's forms go through; NULL = the default flow.
  onay_akisi_id INT NULL,
  -- The user's organisation (organizasyonlar); NULL = none.
  organizasyon_id INT NULL
);
CREATE UNIQUE INDEX ux_kullanicilar_eposta ON dbo.kullanicilar (eposta);

-- Only the SHA-256 of a session token is stored; a database leak does not leak live sessions.
CREATE TABLE dbo.oturumlar (
  token_ozeti CHAR(64) NOT NULL CONSTRAINT pk_oturumlar PRIMARY KEY,
  kullanici_id INT NOT NULL CONSTRAINT fk_oturumlar_kullanici REFERENCES dbo.kullanicilar (id),
  istemci VARCHAR(16) NOT NULL CONSTRAINT ck_oturumlar_istemci CHECK (istemci IN ('panel', 'mobil', 'api')),
  olusturma DATETIME2(3) NOT NULL CONSTRAINT df_oturumlar_olusturma DEFAULT SYSUTCDATETIME(),
  son_erisim DATETIME2(3) NOT NULL CONSTRAINT df_oturumlar_son_erisim DEFAULT SYSUTCDATETIME(),
  son_kullanma DATETIME2(3) NOT NULL
);
CREATE INDEX ix_oturumlar_kullanici ON dbo.oturumlar (kullanici_id);
CREATE INDEX ix_oturumlar_son_kullanma ON dbo.oturumlar (son_kullanma);

-- ---------------------------------------------------------------------------------------------------
-- Definition lists: categories, organisations and cost centres (docs/onay-sistemi.md, section 6,
-- "Tanım listeleri"). Imports match rows by code (by name for categories).

CREATE TABLE dbo.masraf_kategorileri (
  id INT IDENTITY(1, 1) NOT NULL CONSTRAINT pk_masraf_kategorileri PRIMARY KEY,
  ad NVARCHAR(60) COLLATE Turkish_100_CI_AS NOT NULL,
  simge VARCHAR(16) NOT NULL CONSTRAINT df_masraf_kategorileri_simge DEFAULT 'diger'
    CONSTRAINT ck_masraf_kategorileri_simge CHECK (simge IN ('yemek', 'ulasim', 'konaklama', 'akaryakit', 'ofis', 'temsil', 'egitim', 'iletisim', 'diger')),
  sira INT NOT NULL CONSTRAINT df_masraf_kategorileri_sira DEFAULT 0,
  aktif BIT NOT NULL CONSTRAINT df_masraf_kategorileri_aktif DEFAULT 1,
  -- Accounting details, carried by Excel import and export.
  kod NVARCHAR(50) COLLATE Turkish_100_CI_AS NULL,
  kdv_oranlari NVARCHAR(50) NULL,
  hesap_kodu NVARCHAR(50) NULL
);
CREATE UNIQUE INDEX ux_masraf_kategorileri_ad ON dbo.masraf_kategorileri (ad);

INSERT INTO dbo.masraf_kategorileri (ad, simge, sira) VALUES
  (N'Yemek', 'yemek', 1),
  (N'Ulaşım', 'ulasim', 2),
  (N'Konaklama', 'konaklama', 3),
  (N'Akaryakıt', 'akaryakit', 4),
  (N'Ofis malzemesi', 'ofis', 5),
  (N'Temsil ve ağırlama', 'temsil', 6),
  (N'Eğitim', 'egitim', 7),
  (N'İletişim', 'iletisim', 8),
  (N'Diğer', 'diger', 9);

-- Organisations (companies). A user belongs to at most one; a form keeps its owner's organisation.
CREATE TABLE dbo.organizasyonlar (
  id INT IDENTITY(1, 1) NOT NULL CONSTRAINT pk_organizasyonlar PRIMARY KEY,
  kod NVARCHAR(50) COLLATE Turkish_100_CI_AS NOT NULL,
  ad NVARCHAR(200) COLLATE Turkish_100_CI_AS NOT NULL,
  -- ISO 4217, upper case; NULL = not set. Informational.
  para_birimi CHAR(3) NULL,
  aktif BIT NOT NULL CONSTRAINT df_organizasyonlar_aktif DEFAULT 1
);
CREATE UNIQUE INDEX ux_organizasyonlar_kod ON dbo.organizasyonlar (kod);

ALTER TABLE dbo.kullanicilar ADD CONSTRAINT fk_kullanicilar_organizasyon FOREIGN KEY (organizasyon_id) REFERENCES dbo.organizasyonlar (id);
CREATE INDEX ix_kullanicilar_organizasyon ON dbo.kullanicilar (organizasyon_id) WHERE organizasyon_id IS NOT NULL;

-- Cost centres. Assigned to users (kullanici_masraf_merkezleri); a form picks one of its owner's.
CREATE TABLE dbo.masraf_merkezleri (
  id INT IDENTITY(1, 1) NOT NULL CONSTRAINT pk_masraf_merkezleri PRIMARY KEY,
  kod NVARCHAR(50) COLLATE Turkish_100_CI_AS NOT NULL,
  aciklama NVARCHAR(200) COLLATE Turkish_100_CI_AS NULL,
  aktif BIT NOT NULL CONSTRAINT df_masraf_merkezleri_aktif DEFAULT 1
);
CREATE UNIQUE INDEX ux_masraf_merkezleri_kod ON dbo.masraf_merkezleri (kod);

CREATE TABLE dbo.kullanici_masraf_merkezleri (
  kullanici_id INT NOT NULL CONSTRAINT fk_kullanici_masraf_merkezleri_kullanici REFERENCES dbo.kullanicilar (id) ON DELETE CASCADE,
  masraf_merkezi_id INT NOT NULL CONSTRAINT fk_kullanici_masraf_merkezleri_merkez REFERENCES dbo.masraf_merkezleri (id),
  CONSTRAINT pk_kullanici_masraf_merkezleri PRIMARY KEY (kullanici_id, masraf_merkezi_id)
);
-- Usage checks before a cost centre is deleted.
CREATE INDEX ix_kullanici_masraf_merkezleri_merkez ON dbo.kullanici_masraf_merkezleri (masraf_merkezi_id);

-- ---------------------------------------------------------------------------------------------------
-- Approval flows (docs/onay-sistemi.md, section 2)

-- Named approval flows. Exactly one is the default; a user may be assigned another one
-- (kullanicilar.onay_akisi_id). The strategy says who sees an amount: 'zincir' every approver up to the
-- one whose limit covers it, 'tek' that approver alone.
CREATE TABLE dbo.onay_akislari (
  id INT IDENTITY(1, 1) NOT NULL CONSTRAINT pk_onay_akislari PRIMARY KEY,
  ad NVARCHAR(80) COLLATE Turkish_100_CI_AS NOT NULL,
  varsayilan BIT NOT NULL CONSTRAINT df_onay_akislari_varsayilan DEFAULT 0,
  olusturma DATETIME2(3) NOT NULL CONSTRAINT df_onay_akislari_olusturma DEFAULT SYSUTCDATETIME(),
  guncelleme DATETIME2(3) NOT NULL CONSTRAINT df_onay_akislari_guncelleme DEFAULT SYSUTCDATETIME(),
  guncelleyen_id INT NULL CONSTRAINT fk_onay_akislari_guncelleyen REFERENCES dbo.kullanicilar (id),
  strateji VARCHAR(8) NOT NULL CONSTRAINT df_onay_akislari_strateji DEFAULT 'zincir'
    CONSTRAINT ck_onay_akislari_strateji CHECK (strateji IN ('zincir', 'tek'))
);
-- Case-insensitive through the column collation.
CREATE UNIQUE INDEX ux_onay_akislari_ad ON dbo.onay_akislari (ad);
-- At most one default here; "at least one" is the service's rule (the default cannot be deleted).
CREATE UNIQUE INDEX ux_onay_akislari_varsayilan ON dbo.onay_akislari (varsayilan) WHERE varsayilan = 1;

INSERT INTO dbo.onay_akislari (ad, varsayilan) VALUES (N'Genel', 1);

ALTER TABLE dbo.kullanicilar ADD CONSTRAINT fk_kullanicilar_onay_akisi FOREIGN KEY (onay_akisi_id) REFERENCES dbo.onay_akislari (id);
CREATE INDEX ix_kullanicilar_onay_akisi ON dbo.kullanicilar (onay_akisi_id) WHERE onay_akisi_id IS NOT NULL;

-- The steps of a flow: approvers in order, each with an approval limit in the base currency, the
-- largest amount they give the final approval for (inclusive). NULL = no limit, the last approver.
-- Rising limits and "at least one approver" are checked by the service before every change.
CREATE TABLE dbo.onay_adimlari (
  id INT IDENTITY(1, 1) NOT NULL CONSTRAINT pk_onay_adimlari PRIMARY KEY,
  akis_id INT NOT NULL CONSTRAINT fk_onay_adimlari_akis REFERENCES dbo.onay_akislari (id) ON DELETE CASCADE,
  sira INT NOT NULL CONSTRAINT ck_onay_adimlari_sira CHECK (sira >= 1),
  onayci_id INT NOT NULL CONSTRAINT fk_onay_adimlari_onayci REFERENCES dbo.kullanicilar (id),
  onay_limiti DECIMAL(18, 2) NULL CONSTRAINT ck_onay_adimlari_limit CHECK (onay_limiti IS NULL OR onay_limiti > 0)
);
-- Order and approver are unique within a flow.
CREATE UNIQUE INDEX ux_onay_adimlari_sira ON dbo.onay_adimlari (akis_id, sira);
CREATE UNIQUE INDEX ux_onay_adimlari_onayci ON dbo.onay_adimlari (akis_id, onayci_id);
-- "Is this user an approver anywhere?" (deactivation guard, user lists).
CREATE INDEX ix_onay_adimlari_onayci ON dbo.onay_adimlari (onayci_id) INCLUDE (akis_id, sira, onay_limiti);

-- ---------------------------------------------------------------------------------------------------
-- Invoices read by Claude

-- The id keeps the format of the old JSON records (YYYYMMDD-HHMMSS-xxxxxxxx).
CREATE TABLE dbo.fatura_kayitlari (
  id VARCHAR(24) NOT NULL CONSTRAINT pk_fatura_kayitlari PRIMARY KEY,
  dosya_adi NVARCHAR(200) NOT NULL,
  dosya_ozeti CHAR(64) NULL,
  olusturma DATETIME2(3) NOT NULL,
  yukleyen_id INT NULL CONSTRAINT fk_fatura_kayitlari_yukleyen REFERENCES dbo.kullanicilar (id),
  sonuc NVARCHAR(MAX) NOT NULL CONSTRAINT ck_fatura_kayitlari_sonuc CHECK (ISJSON(sonuc) = 1),
  olcum NVARCHAR(MAX) NULL,
  -- Copies of a few invoice fields for lists; the JSON in sonuc is the source.
  fatura_no NVARCHAR(200) NULL,
  fatura_tarihi DATE NULL,
  satici_unvan NVARCHAR(400) COLLATE Turkish_100_CI_AS NULL,
  genel_toplam FLOAT NULL,
  para_birimi CHAR(3) NULL
);
CREATE INDEX ix_fatura_kayitlari_ozet ON dbo.fatura_kayitlari (dosya_ozeti, olusturma DESC) WHERE dosya_ozeti IS NOT NULL;
CREATE INDEX ix_fatura_kayitlari_olusturma ON dbo.fatura_kayitlari (olusturma DESC);

CREATE TABLE dbo.fatura_dosyalari (
  kayit_id VARCHAR(24) NOT NULL CONSTRAINT pk_fatura_dosyalari PRIMARY KEY
    CONSTRAINT fk_fatura_dosyalari_kayit REFERENCES dbo.fatura_kayitlari (id) ON DELETE CASCADE,
  mime VARCHAR(40) NOT NULL,
  boyut INT NOT NULL,
  icerik VARBINARY(MAX) NOT NULL
);

-- Every upload, including ones answered from an earlier read of the same file. Access to an
-- invoice comes from here.
CREATE TABLE dbo.fatura_yuklemeleri (
  id BIGINT IDENTITY(1, 1) NOT NULL CONSTRAINT pk_fatura_yuklemeleri PRIMARY KEY,
  kayit_id VARCHAR(24) NOT NULL CONSTRAINT fk_fatura_yuklemeleri_kayit REFERENCES dbo.fatura_kayitlari (id) ON DELETE CASCADE,
  kullanici_id INT NOT NULL CONSTRAINT fk_fatura_yuklemeleri_kullanici REFERENCES dbo.kullanicilar (id),
  dosya_adi NVARCHAR(200) NOT NULL,
  tarih DATETIME2(3) NOT NULL CONSTRAINT df_fatura_yuklemeleri_tarih DEFAULT SYSUTCDATETIME()
);
CREATE INDEX ix_fatura_yuklemeleri_kullanici ON dbo.fatura_yuklemeleri (kullanici_id, kayit_id);
CREATE INDEX ix_fatura_yuklemeleri_kayit ON dbo.fatura_yuklemeleri (kayit_id);

-- ---------------------------------------------------------------------------------------------------
-- Expense forms

CREATE TABLE dbo.masraf_formlari (
  id INT IDENTITY(1001, 1) NOT NULL CONSTRAINT pk_masraf_formlari PRIMARY KEY,
  olusturan_id INT NOT NULL CONSTRAINT fk_masraf_formlari_olusturan REFERENCES dbo.kullanicilar (id),
  -- The owner's organisation and the form's cost centre (one of its owner's), copied on every save by
  -- the owner and on sending.
  organizasyon_id INT NULL CONSTRAINT fk_masraf_formlari_organizasyon REFERENCES dbo.organizasyonlar (id),
  masraf_merkezi_id INT NULL CONSTRAINT fk_masraf_formlari_masraf_merkezi REFERENCES dbo.masraf_merkezleri (id),
  baslik NVARCHAR(120) COLLATE Turkish_100_CI_AS NOT NULL,
  aciklama NVARCHAR(1000) COLLATE Turkish_100_CI_AS NULL,
  kategori_id INT NOT NULL CONSTRAINT fk_masraf_formlari_kategori REFERENCES dbo.masraf_kategorileri (id),
  masraf_tarihi DATE NOT NULL,
  satici NVARCHAR(200) COLLATE Turkish_100_CI_AS NULL,
  -- A draft may leave the amount empty until its invoices are read; every other state needs it.
  tutar DECIMAL(18, 2) NULL,
  para_birimi CHAR(3) NOT NULL,
  kur DECIMAL(18, 6) NULL CONSTRAINT ck_masraf_formlari_kur CHECK (kur IS NULL OR kur > 0),
  yerel_tutar DECIMAL(18, 2) NULL,
  -- Amount the approvers were picked by, set when the form is sent.
  onay_tutari DECIMAL(18, 2) NULL,
  durum VARCHAR(16) NOT NULL CONSTRAINT ck_masraf_formlari_durum CHECK (durum IN ('taslak', 'onayda', 'onaylandi', 'reddedildi', 'iptal', 'odendi')),
  -- "Okununca gönder": once no file of the form waits any more, the server tries to send it for approval.
  okununca_gonder BIT NOT NULL CONSTRAINT df_masraf_formlari_okununca_gonder DEFAULT 0,
  -- Send count; approval rows of earlier sends keep their own tur.
  tur INT NOT NULL CONSTRAINT df_masraf_formlari_tur DEFAULT 0,
  olusturma DATETIME2(3) NOT NULL CONSTRAINT df_masraf_formlari_olusturma DEFAULT SYSUTCDATETIME(),
  guncelleme DATETIME2(3) NOT NULL CONSTRAINT df_masraf_formlari_guncelleme DEFAULT SYSUTCDATETIME(),
  gonderim DATETIME2(3) NULL,
  sonuclanma DATETIME2(3) NULL,
  odeme DATETIME2(3) NULL,
  CONSTRAINT ck_masraf_formlari_tutar CHECK ((tutar IS NULL AND durum = 'taslak') OR (tutar IS NOT NULL AND tutar > 0)),
  CONSTRAINT ck_masraf_formlari_yerel_tutar CHECK ((tutar IS NULL AND yerel_tutar IS NULL) OR (tutar IS NOT NULL AND yerel_tutar IS NOT NULL))
);
CREATE INDEX ix_masraf_formlari_olusturan ON dbo.masraf_formlari (olusturan_id, olusturma DESC);
CREATE INDEX ix_masraf_formlari_durum ON dbo.masraf_formlari (durum, gonderim DESC);
CREATE INDEX ix_masraf_formlari_masraf_merkezi ON dbo.masraf_formlari (masraf_merkezi_id) WHERE masraf_merkezi_id IS NOT NULL;
CREATE INDEX ix_masraf_formlari_organizasyon ON dbo.masraf_formlari (organizasyon_id) WHERE organizasyon_id IS NOT NULL;

-- The invoices of a form (at most 20, checked by the service). `aktif` turns 0 when the form is
-- cancelled: the cancelled form keeps showing its invoices, and they become free for another form.
CREATE TABLE dbo.form_faturalari (
  form_id INT NOT NULL CONSTRAINT fk_form_faturalari_form REFERENCES dbo.masraf_formlari (id) ON DELETE CASCADE,
  kayit_id VARCHAR(24) NOT NULL CONSTRAINT fk_form_faturalari_kayit REFERENCES dbo.fatura_kayitlari (id),
  -- Order the invoices were added in, from 1.
  sira INT NOT NULL CONSTRAINT ck_form_faturalari_sira CHECK (sira >= 1),
  aktif BIT NOT NULL CONSTRAINT df_form_faturalari_aktif DEFAULT 1,
  -- The base-currency equivalent the sender entered for an invoice in a third currency (neither the
  -- form's nor the base currency), counted toward the approval amount (docs/onay-sistemi.md,
  -- section 3, rule 6). NULL when the invoice does not need one or it has not been entered yet.
  yerel_karsilik DECIMAL(18, 2) NULL CONSTRAINT ck_form_faturalari_karsilik CHECK (yerel_karsilik IS NULL OR yerel_karsilik > 0),
  -- The user's correction of the read invoice on this form only, the whole invoice JSON
  -- ({ fatura, kalemler }); NULL = no correction, the read result in fatura_kayitlari.sonuc holds.
  duzeltme NVARCHAR(MAX) NULL CONSTRAINT ck_form_faturalari_duzeltme CHECK (duzeltme IS NULL OR ISJSON(duzeltme) = 1),
  -- The duplicate key of the invoice's effective data (correction or read result), computed by the
  -- application on every write (src/invoice/effective.ts); NULL without an invoice number. A binary
  -- collation keeps comparisons exact: the application already normalises the key, and a Turkish
  -- case-insensitive collation would treat I/ı and İ/i as equal.
  mukerrer_anahtari NVARCHAR(450) COLLATE Latin1_General_100_BIN2 NULL,
  CONSTRAINT pk_form_faturalari PRIMARY KEY (form_id, kayit_id)
);
CREATE UNIQUE INDEX ux_form_faturalari_sira ON dbo.form_faturalari (form_id, sira);
-- One invoice, one live form: an invoice cannot be claimed twice.
CREATE UNIQUE INDEX ux_form_faturalari_kayit ON dbo.form_faturalari (kayit_id) WHERE aktif = 1;
-- Access checks find the forms of an invoice, cancelled ones included.
CREATE INDEX ix_form_faturalari_kayit ON dbo.form_faturalari (kayit_id) INCLUDE (aktif);
-- Not unique: two drafts may hold the same key; sending is refused by the application, which
-- serialises sends with an application lock (sp_getapplock) so two forms cannot pass at once.
CREATE INDEX ix_form_faturalari_mukerrer ON dbo.form_faturalari (mukerrer_anahtari) INCLUDE (form_id)
  WHERE aktif = 1 AND mukerrer_anahtari IS NOT NULL;

-- Reading in the background (docs/onay-sistemi.md, section 3, "Arka planda okuma"): a form may be saved
-- before Claude has read its files. Such a file waits here, with its bytes, until it is read; then it
-- becomes an invoice link (form_faturalari) and its row is deleted. A failed read stays as 'hata' until
-- the owner reads it again or takes it off the form. A restarted server reads the waiting rows again.
CREATE TABLE dbo.bekleyen_faturalar (
  id INT IDENTITY(1, 1) NOT NULL CONSTRAINT pk_bekleyen_faturalar PRIMARY KEY,
  form_id INT NOT NULL CONSTRAINT fk_bekleyen_faturalar_form REFERENCES dbo.masraf_formlari (id) ON DELETE CASCADE,
  -- Who added the file; the read is noted as their upload.
  kullanici_id INT NOT NULL CONSTRAINT fk_bekleyen_faturalar_kullanici REFERENCES dbo.kullanicilar (id),
  dosya_adi NVARCHAR(200) NOT NULL,
  -- SHA-256 of the file, lower-case hex: how clients name the file and how the reader finds a running read.
  dosya_ozeti CHAR(64) NOT NULL,
  mime VARCHAR(40) NOT NULL,
  boyut INT NOT NULL CONSTRAINT ck_bekleyen_faturalar_boyut CHECK (boyut > 0),
  icerik VARBINARY(MAX) NOT NULL,
  durum VARCHAR(12) NOT NULL CONSTRAINT df_bekleyen_faturalar_durum DEFAULT 'bekliyor'
    CONSTRAINT ck_bekleyen_faturalar_durum CHECK (durum IN ('bekliyor', 'hata')),
  hata_kodu VARCHAR(40) NULL,
  hata_mesaji NVARCHAR(500) NULL,
  olusturma DATETIME2(3) NOT NULL CONSTRAINT df_bekleyen_faturalar_olusturma DEFAULT SYSUTCDATETIME(),
  CONSTRAINT ck_bekleyen_faturalar_hata CHECK ((durum = 'hata' AND hata_kodu IS NOT NULL) OR (durum = 'bekliyor' AND hata_kodu IS NULL AND hata_mesaji IS NULL))
);
-- A file is on a form once.
CREATE UNIQUE INDEX ux_bekleyen_faturalar_dosya ON dbo.bekleyen_faturalar (form_id, dosya_ozeti);
-- The rows still to read, at start-up.
CREATE INDEX ix_bekleyen_faturalar_durum ON dbo.bekleyen_faturalar (durum) INCLUDE (form_id);

-- The approvers of one send of a form, copied from the flow at send time. alt_limit and ust_limit are
-- the band of amounts that reaches the approver.
CREATE TABLE dbo.form_onaylari (
  id INT IDENTITY(1, 1) NOT NULL CONSTRAINT pk_form_onaylari PRIMARY KEY,
  form_id INT NOT NULL CONSTRAINT fk_form_onaylari_form REFERENCES dbo.masraf_formlari (id) ON DELETE CASCADE,
  tur INT NOT NULL,
  sira INT NOT NULL,
  onayci_id INT NOT NULL CONSTRAINT fk_form_onaylari_onayci REFERENCES dbo.kullanicilar (id),
  alt_limit DECIMAL(18, 2) NOT NULL,
  ust_limit DECIMAL(18, 2) NULL,
  -- Fallback approver: every matching approver was the sender, so an administrator decides.
  yedek BIT NOT NULL CONSTRAINT df_form_onaylari_yedek DEFAULT 0,
  durum VARCHAR(16) NOT NULL CONSTRAINT ck_form_onaylari_durum CHECK (durum IN ('sirada', 'bekliyor', 'onaylandi', 'reddedildi', 'atlandi', 'iptal')),
  aciklama NVARCHAR(500) COLLATE Turkish_100_CI_AS NULL,
  karar_tarihi DATETIME2(3) NULL,
  olusturma DATETIME2(3) NOT NULL CONSTRAINT df_form_onaylari_olusturma DEFAULT SYSUTCDATETIME(),
  -- When the approver of this step was last reminded; NULL = never.
  son_hatirlatma DATETIME2(3) NULL
);
CREATE UNIQUE INDEX ux_form_onaylari_sira ON dbo.form_onaylari (form_id, tur, sira);
CREATE INDEX ix_form_onaylari_onayci ON dbo.form_onaylari (onayci_id, durum) INCLUDE (form_id, karar_tarihi);
-- At most one step of a form waits for a decision.
CREATE UNIQUE INDEX ux_form_onaylari_bekleyen ON dbo.form_onaylari (form_id) WHERE durum = 'bekliyor';

CREATE TABLE dbo.form_gecmisi (
  id BIGINT IDENTITY(1, 1) NOT NULL CONSTRAINT pk_form_gecmisi PRIMARY KEY,
  form_id INT NOT NULL CONSTRAINT fk_form_gecmisi_form REFERENCES dbo.masraf_formlari (id) ON DELETE CASCADE,
  kullanici_id INT NULL CONSTRAINT fk_form_gecmisi_kullanici REFERENCES dbo.kullanicilar (id),
  islem VARCHAR(24) NOT NULL,
  aciklama NVARCHAR(500) COLLATE Turkish_100_CI_AS NULL,
  tarih DATETIME2(3) NOT NULL CONSTRAINT df_form_gecmisi_tarih DEFAULT SYSUTCDATETIME()
);
CREATE INDEX ix_form_gecmisi_form ON dbo.form_gecmisi (form_id, id);

CREATE TABLE dbo.denetim_kayitlari (
  id BIGINT IDENTITY(1, 1) NOT NULL CONSTRAINT pk_denetim_kayitlari PRIMARY KEY,
  kullanici_id INT NULL CONSTRAINT fk_denetim_kayitlari_kullanici REFERENCES dbo.kullanicilar (id),
  islem VARCHAR(40) NOT NULL,
  ayrinti NVARCHAR(1000) COLLATE Turkish_100_CI_AS NULL,
  tarih DATETIME2(3) NOT NULL CONSTRAINT df_denetim_kayitlari_tarih DEFAULT SYSUTCDATETIME()
);
CREATE INDEX ix_denetim_kayitlari_tarih ON dbo.denetim_kayitlari (tarih DESC);

-- ---------------------------------------------------------------------------------------------------
-- In-app notifications and the outgoing mail box (docs/onay-sistemi.md, sections 4 and 7). Both are
-- written in the transaction of the action that causes them.

CREATE TABLE dbo.bildirimler (
  id INT IDENTITY(1, 1) NOT NULL CONSTRAINT pk_bildirimler PRIMARY KEY,
  kullanici_id INT NOT NULL CONSTRAINT fk_bildirimler_kullanici REFERENCES dbo.kullanicilar (id),
  tur VARCHAR(20) NOT NULL,
  form_id INT NULL CONSTRAINT fk_bildirimler_form REFERENCES dbo.masraf_formlari (id) ON DELETE CASCADE,
  baslik NVARCHAR(200) COLLATE Turkish_100_CI_AS NOT NULL,
  mesaj NVARCHAR(1000) COLLATE Turkish_100_CI_AS NOT NULL,
  olusturma DATETIME2(3) NOT NULL CONSTRAINT df_bildirimler_olusturma DEFAULT SYSUTCDATETIME(),
  -- NULL = not read yet.
  okunma DATETIME2(3) NULL,
  -- The form title the notification was written with, so its list never shows a title changed later
  -- (to someone who may no longer see the form, e.g. an approver whose step was handed on).
  form_baslik NVARCHAR(120) COLLATE Turkish_100_CI_AS NULL,
  CONSTRAINT ck_bildirimler_tur
    CHECK (tur IN ('onay_bekliyor', 'hatirlatma', 'devredildi', 'onaylandi', 'reddedildi', 'odendi', 'odeme_bekliyor',
                   'okuma_bitti', 'okuma_hatasi', 'onaya_gonderildi', 'onaya_gonderilemedi'))
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

-- ---------------------------------------------------------------------------------------------------
-- Fields and required-field rules (docs/onay-sistemi.md, section 3, "Fiş alanları, masraf merkezi ve
-- zorunluluk kuralları", section 6, "Fiş alanları")

-- Field definitions. Form level: the category (always required) and the cost centre. Receipt level: the
-- read invoice's header fields ('fatura': only whether they are required can change) and the fields the
-- sender fills in on each receipt. 'sistem' rows cannot be deleted.
CREATE TABLE dbo.alan_tanimlari (
  id INT IDENTITY(1, 1) NOT NULL CONSTRAINT pk_alan_tanimlari PRIMARY KEY,
  -- API name, camelCase ASCII; never changes.
  anahtar VARCHAR(40) COLLATE Latin1_General_100_BIN2 NOT NULL,
  ad NVARCHAR(60) COLLATE Turkish_100_CI_AS NOT NULL,
  duzey VARCHAR(8) NOT NULL CONSTRAINT ck_alan_tanimlari_duzey CHECK (duzey IN ('form', 'fis')),
  tur VARCHAR(16) NOT NULL
    CONSTRAINT ck_alan_tanimlari_tur CHECK (tur IN ('kategori', 'masraf_merkezi', 'fatura', 'liste', 'metin', 'uzun_metin', 'sayi', 'tarih')),
  zorunlu BIT NOT NULL CONSTRAINT df_alan_tanimlari_zorunlu DEFAULT 0,
  aktif BIT NOT NULL CONSTRAINT df_alan_tanimlari_aktif DEFAULT 1,
  sira INT NOT NULL CONSTRAINT df_alan_tanimlari_sira DEFAULT 0,
  sistem BIT NOT NULL CONSTRAINT df_alan_tanimlari_sistem DEFAULT 0,
  -- Help text shown next to the field.
  aciklama NVARCHAR(200) COLLATE Turkish_100_CI_AS NULL,
  CONSTRAINT ck_alan_tanimlari_duzey_tur CHECK ((duzey = 'form' AND tur IN ('kategori', 'masraf_merkezi')) OR (duzey = 'fis' AND tur NOT IN ('kategori', 'masraf_merkezi'))),
  CONSTRAINT ck_alan_tanimlari_sistem CHECK (sistem = 1 OR tur NOT IN ('kategori', 'masraf_merkezi', 'fatura'))
);
CREATE UNIQUE INDEX ux_alan_tanimlari_anahtar ON dbo.alan_tanimlari (anahtar);
CREATE UNIQUE INDEX ux_alan_tanimlari_ad ON dbo.alan_tanimlari (ad);

-- The options of a 'liste' field.
CREATE TABLE dbo.alan_secenekleri (
  id INT IDENTITY(1, 1) NOT NULL CONSTRAINT pk_alan_secenekleri PRIMARY KEY,
  alan_id INT NOT NULL CONSTRAINT fk_alan_secenekleri_alan REFERENCES dbo.alan_tanimlari (id) ON DELETE CASCADE,
  kod NVARCHAR(50) COLLATE Turkish_100_CI_AS NOT NULL,
  ad NVARCHAR(200) COLLATE Turkish_100_CI_AS NULL,
  aktif BIT NOT NULL CONSTRAINT df_alan_secenekleri_aktif DEFAULT 1,
  sira INT NOT NULL CONSTRAINT df_alan_secenekleri_sira DEFAULT 0
);
CREATE UNIQUE INDEX ux_alan_secenekleri_kod ON dbo.alan_secenekleri (alan_id, kod);

-- "When <condition field> is <value>, these fields are required." The condition field is the category,
-- the cost centre or a 'liste' receipt field; kosul_deger_id is a row of masraf_kategorileri,
-- masraf_merkezleri or alan_secenekleri accordingly (checked by the application, which also deletes the
-- rules of a deleted value or field).
CREATE TABLE dbo.alan_kurallari (
  id INT IDENTITY(1, 1) NOT NULL CONSTRAINT pk_alan_kurallari PRIMARY KEY,
  kosul_alan_id INT NOT NULL CONSTRAINT fk_alan_kurallari_alan REFERENCES dbo.alan_tanimlari (id),
  kosul_deger_id INT NOT NULL,
  olusturma DATETIME2(3) NOT NULL CONSTRAINT df_alan_kurallari_olusturma DEFAULT SYSUTCDATETIME()
);
CREATE UNIQUE INDEX ux_alan_kurallari_kosul ON dbo.alan_kurallari (kosul_alan_id, kosul_deger_id);

CREATE TABLE dbo.alan_kurali_hedefleri (
  kural_id INT NOT NULL CONSTRAINT fk_alan_kurali_hedefleri_kural REFERENCES dbo.alan_kurallari (id) ON DELETE CASCADE,
  alan_id INT NOT NULL CONSTRAINT fk_alan_kurali_hedefleri_alan REFERENCES dbo.alan_tanimlari (id),
  CONSTRAINT pk_alan_kurali_hedefleri PRIMARY KEY (kural_id, alan_id)
);
CREATE INDEX ix_alan_kurali_hedefleri_alan ON dbo.alan_kurali_hedefleri (alan_id);

-- Receipt field values of an invoice on a form. 'liste' fields hold an option, the others text ('sayi'
-- as a canonical number, 'tarih' as YYYY-MM-DD). Removed with the invoice's link.
CREATE TABLE dbo.fis_alan_degerleri (
  form_id INT NOT NULL,
  kayit_id VARCHAR(24) NOT NULL,
  alan_id INT NOT NULL CONSTRAINT fk_fis_alan_degerleri_alan REFERENCES dbo.alan_tanimlari (id),
  secenek_id INT NULL CONSTRAINT fk_fis_alan_degerleri_secenek REFERENCES dbo.alan_secenekleri (id),
  metin NVARCHAR(1000) COLLATE Turkish_100_CI_AS NULL,
  CONSTRAINT pk_fis_alan_degerleri PRIMARY KEY (form_id, kayit_id, alan_id),
  CONSTRAINT fk_fis_alan_degerleri_fatura FOREIGN KEY (form_id, kayit_id) REFERENCES dbo.form_faturalari (form_id, kayit_id) ON DELETE CASCADE,
  CONSTRAINT ck_fis_alan_degerleri_deger CHECK ((secenek_id IS NOT NULL AND metin IS NULL) OR (secenek_id IS NULL AND metin IS NOT NULL))
);
CREATE INDEX ix_fis_alan_degerleri_alan ON dbo.fis_alan_degerleri (alan_id);
CREATE INDEX ix_fis_alan_degerleri_secenek ON dbo.fis_alan_degerleri (secenek_id) WHERE secenek_id IS NOT NULL;

-- The same for a file still being read; moved to fis_alan_degerleri when it becomes an invoice.
CREATE TABLE dbo.bekleyen_alan_degerleri (
  bekleyen_id INT NOT NULL CONSTRAINT fk_bekleyen_alan_degerleri_bekleyen REFERENCES dbo.bekleyen_faturalar (id) ON DELETE CASCADE,
  alan_id INT NOT NULL CONSTRAINT fk_bekleyen_alan_degerleri_alan REFERENCES dbo.alan_tanimlari (id),
  secenek_id INT NULL CONSTRAINT fk_bekleyen_alan_degerleri_secenek REFERENCES dbo.alan_secenekleri (id),
  metin NVARCHAR(1000) COLLATE Turkish_100_CI_AS NULL,
  CONSTRAINT pk_bekleyen_alan_degerleri PRIMARY KEY (bekleyen_id, alan_id),
  CONSTRAINT ck_bekleyen_alan_degerleri_deger CHECK ((secenek_id IS NOT NULL AND metin IS NULL) OR (secenek_id IS NULL AND metin IS NOT NULL))
);
CREATE INDEX ix_bekleyen_alan_degerleri_alan ON dbo.bekleyen_alan_degerleri (alan_id);
CREATE INDEX ix_bekleyen_alan_degerleri_secenek ON dbo.bekleyen_alan_degerleri (secenek_id) WHERE secenek_id IS NOT NULL;

-- The built-in fields. Invoice number, date, seller and grand total start required; every receipt
-- field starts optional.
INSERT INTO dbo.alan_tanimlari (anahtar, ad, duzey, tur, zorunlu, sira, sistem) VALUES
  ('kategori', N'Kategori', 'form', 'kategori', 1, 1, 1),
  ('masrafMerkezi', N'Masraf Merkezi', 'form', 'masraf_merkezi', 0, 2, 1),
  ('faturaNo', N'Fatura No', 'fis', 'fatura', 1, 1, 1),
  ('faturaTarihi', N'Fatura Tarihi', 'fis', 'fatura', 1, 2, 1),
  ('saticiUnvan', N'Satıcı', 'fis', 'fatura', 1, 3, 1),
  ('saticiVergiNo', N'Satıcı Vergi No', 'fis', 'fatura', 0, 4, 1),
  ('aliciUnvan', N'Alıcı', 'fis', 'fatura', 0, 5, 1),
  ('aliciVergiNo', N'Alıcı Vergi No', 'fis', 'fatura', 0, 6, 1),
  ('paraBirimi', N'Para Birimi', 'fis', 'fatura', 0, 7, 1),
  ('araToplam', N'Ara Toplam', 'fis', 'fatura', 0, 8, 1),
  ('kdvToplam', N'KDV Toplamı', 'fis', 'fatura', 0, 9, 1),
  ('genelToplam', N'Genel Toplam', 'fis', 'fatura', 1, 10, 1),
  ('etiket', N'Etiket', 'fis', 'liste', 0, 11, 0),
  ('projeKodu', N'Proje Kodu', 'fis', 'liste', 0, 12, 0),
  ('odemeYontemi', N'Ödeme Yöntemi', 'fis', 'liste', 0, 13, 0),
  ('dokumanTipi', N'Doküman Tipi', 'fis', 'liste', 0, 14, 0),
  ('kkegTuru', N'KKEG Türü', 'fis', 'liste', 0, 15, 0),
  ('vergiDairesi', N'Vergi Dairesi', 'fis', 'metin', 0, 16, 0),
  ('not', N'Not', 'fis', 'uzun_metin', 0, 17, 0);

INSERT INTO dbo.alan_secenekleri (alan_id, kod, sira)
SELECT a.id, v.kod, v.sira
FROM dbo.alan_tanimlari a
JOIN (VALUES
  ('odemeYontemi', N'Nakit', 1),
  ('odemeYontemi', N'Kredi Kartı', 2),
  ('odemeYontemi', N'Şirket Kartı', 3),
  ('odemeYontemi', N'Banka Havalesi', 4),
  ('dokumanTipi', N'Fiş', 1),
  ('dokumanTipi', N'Fatura', 2),
  ('dokumanTipi', N'e-Arşiv Fatura', 3),
  ('dokumanTipi', N'e-Fatura', 4),
  ('dokumanTipi', N'Serbest Meslek Makbuzu', 5),
  ('dokumanTipi', N'Gider Pusulası', 6)
) v (anahtar, kod, sira) ON a.anahtar = v.anahtar;

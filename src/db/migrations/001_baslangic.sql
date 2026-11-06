-- Users, sessions, approval flows, invoice records and expense forms.
-- See docs/onay-sistemi.md for the rules these tables enforce.

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
  olusturma DATETIME2(3) NOT NULL CONSTRAINT df_kullanicilar_olusturma DEFAULT SYSUTCDATETIME(),
  guncelleme DATETIME2(3) NOT NULL CONSTRAINT df_kullanicilar_guncelleme DEFAULT SYSUTCDATETIME(),
  son_giris DATETIME2(3) NULL,
  -- The approval flow the user's forms go through; NULL = the default flow.
  onay_akisi_id INT NULL
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

CREATE TABLE dbo.masraf_kategorileri (
  id INT IDENTITY(1, 1) NOT NULL CONSTRAINT pk_masraf_kategorileri PRIMARY KEY,
  ad NVARCHAR(60) COLLATE Turkish_100_CI_AS NOT NULL,
  simge VARCHAR(16) NOT NULL CONSTRAINT df_masraf_kategorileri_simge DEFAULT 'diger'
    CONSTRAINT ck_masraf_kategorileri_simge CHECK (simge IN ('yemek', 'ulasim', 'konaklama', 'akaryakit', 'ofis', 'temsil', 'egitim', 'iletisim', 'diger')),
  sira INT NOT NULL CONSTRAINT df_masraf_kategorileri_sira DEFAULT 0,
  aktif BIT NOT NULL CONSTRAINT df_masraf_kategorileri_aktif DEFAULT 1
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

-- Named approval flows ("onay stratejisi"). Exactly one is the default; a user may be assigned another
-- one (kullanicilar.onay_akisi_id). See docs/onay-sistemi.md, section 2.
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

ALTER TABLE dbo.kullanicilar ADD CONSTRAINT fk_kullanicilar_onay_akisi FOREIGN KEY (onay_akisi_id) REFERENCES dbo.onay_akislari (id);
CREATE INDEX ix_kullanicilar_onay_akisi ON dbo.kullanicilar (onay_akisi_id) WHERE onay_akisi_id IS NOT NULL;

-- The steps of a flow: approvers in order, each with an inclusive amount range in the base currency.
-- Coverage of 0..infinity and "at least one approver" are checked by the service before every change.
CREATE TABLE dbo.onay_adimlari (
  id INT IDENTITY(1, 1) NOT NULL CONSTRAINT pk_onay_adimlari PRIMARY KEY,
  akis_id INT NOT NULL CONSTRAINT fk_onay_adimlari_akis REFERENCES dbo.onay_akislari (id) ON DELETE CASCADE,
  sira INT NOT NULL CONSTRAINT ck_onay_adimlari_sira CHECK (sira >= 1),
  onayci_id INT NOT NULL CONSTRAINT fk_onay_adimlari_onayci REFERENCES dbo.kullanicilar (id),
  alt_limit DECIMAL(18, 2) NOT NULL CONSTRAINT ck_onay_adimlari_alt CHECK (alt_limit >= 0),
  ust_limit DECIMAL(18, 2) NULL,
  CONSTRAINT ck_onay_adimlari_aralik CHECK (ust_limit IS NULL OR ust_limit >= alt_limit)
);
-- Order and approver are unique within a flow.
CREATE UNIQUE INDEX ux_onay_adimlari_sira ON dbo.onay_adimlari (akis_id, sira);
CREATE UNIQUE INDEX ux_onay_adimlari_onayci ON dbo.onay_adimlari (akis_id, onayci_id);
-- "Is this user an approver anywhere?" (deactivation guard, user lists).
CREATE INDEX ix_onay_adimlari_onayci ON dbo.onay_adimlari (onayci_id) INCLUDE (akis_id, sira, alt_limit, ust_limit);

-- Invoices read by Claude. The id keeps the format of the old JSON records (YYYYMMDD-HHMMSS-xxxxxxxx).
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

CREATE TABLE dbo.masraf_formlari (
  id INT IDENTITY(1001, 1) NOT NULL CONSTRAINT pk_masraf_formlari PRIMARY KEY,
  olusturan_id INT NOT NULL CONSTRAINT fk_masraf_formlari_olusturan REFERENCES dbo.kullanicilar (id),
  baslik NVARCHAR(120) COLLATE Turkish_100_CI_AS NOT NULL,
  aciklama NVARCHAR(1000) COLLATE Turkish_100_CI_AS NULL,
  kategori_id INT NOT NULL CONSTRAINT fk_masraf_formlari_kategori REFERENCES dbo.masraf_kategorileri (id),
  masraf_tarihi DATE NOT NULL,
  satici NVARCHAR(200) COLLATE Turkish_100_CI_AS NULL,
  tutar DECIMAL(18, 2) NOT NULL CONSTRAINT ck_masraf_formlari_tutar CHECK (tutar > 0),
  para_birimi CHAR(3) NOT NULL,
  kur DECIMAL(18, 6) NULL CONSTRAINT ck_masraf_formlari_kur CHECK (kur IS NULL OR kur > 0),
  yerel_tutar DECIMAL(18, 2) NOT NULL,
  -- Amount the approvers were picked by, set when the form is sent.
  onay_tutari DECIMAL(18, 2) NULL,
  durum VARCHAR(16) NOT NULL CONSTRAINT ck_masraf_formlari_durum CHECK (durum IN ('taslak', 'onayda', 'onaylandi', 'reddedildi', 'iptal', 'odendi')),
  -- Send count; approval rows of earlier sends keep their own tur.
  tur INT NOT NULL CONSTRAINT df_masraf_formlari_tur DEFAULT 0,
  olusturma DATETIME2(3) NOT NULL CONSTRAINT df_masraf_formlari_olusturma DEFAULT SYSUTCDATETIME(),
  guncelleme DATETIME2(3) NOT NULL CONSTRAINT df_masraf_formlari_guncelleme DEFAULT SYSUTCDATETIME(),
  gonderim DATETIME2(3) NULL,
  sonuclanma DATETIME2(3) NULL,
  odeme DATETIME2(3) NULL
);
CREATE INDEX ix_masraf_formlari_olusturan ON dbo.masraf_formlari (olusturan_id, olusturma DESC);
CREATE INDEX ix_masraf_formlari_durum ON dbo.masraf_formlari (durum, gonderim DESC);

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
  CONSTRAINT pk_form_faturalari PRIMARY KEY (form_id, kayit_id)
);
CREATE UNIQUE INDEX ux_form_faturalari_sira ON dbo.form_faturalari (form_id, sira);
-- One invoice, one live form: an invoice cannot be claimed twice.
CREATE UNIQUE INDEX ux_form_faturalari_kayit ON dbo.form_faturalari (kayit_id) WHERE aktif = 1;
-- Access checks find the forms of an invoice, cancelled ones included.
CREATE INDEX ix_form_faturalari_kayit ON dbo.form_faturalari (kayit_id) INCLUDE (aktif);

-- The approvers of one send of a form, copied from the flow at send time.
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
  olusturma DATETIME2(3) NOT NULL CONSTRAINT df_form_onaylari_olusturma DEFAULT SYSUTCDATETIME()
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

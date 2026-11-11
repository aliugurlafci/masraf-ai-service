-- Integrations (docs/onay-sistemi.md, section 9): approved expense forms sent to an outside system such
-- as SAP PI/PO, as JSON or XML built from the fields an administrator picked, each under its own alias.

CREATE TABLE dbo.entegrasyonlar (
  id INT IDENTITY(1, 1) NOT NULL CONSTRAINT pk_entegrasyonlar PRIMARY KEY,
  ad NVARCHAR(80) COLLATE Turkish_100_CI_AS NOT NULL CONSTRAINT uq_entegrasyonlar_ad UNIQUE,
  aktif BIT NOT NULL CONSTRAINT df_entegrasyonlar_aktif DEFAULT 1,
  adres NVARCHAR(2000) NOT NULL,
  yontem VARCHAR(8) NOT NULL CONSTRAINT df_entegrasyonlar_yontem DEFAULT 'POST'
    CONSTRAINT ck_entegrasyonlar_yontem CHECK (yontem IN ('POST', 'PUT')),
  bicim VARCHAR(8) NOT NULL CONSTRAINT ck_entegrasyonlar_bicim CHECK (bicim IN ('json', 'xml')),
  -- Root element (required for XML), the XML namespace of the root, the receipt list and its item.
  kok VARCHAR(60) NULL,
  xml_ad_alani NVARCHAR(400) NULL,
  fis_listesi VARCHAR(60) NOT NULL,
  fis_ogesi VARCHAR(60) NOT NULL,
  tarih_bicimi VARCHAR(12) NOT NULL CONSTRAINT df_entegrasyonlar_tarih DEFAULT 'YYYY-AA-GG'
    CONSTRAINT ck_entegrasyonlar_tarih CHECK (tarih_bicimi IN ('YYYY-AA-GG', 'YYYYAAGG', 'GG.AA.YYYY')),
  tetikleyici VARCHAR(12) NOT NULL CONSTRAINT df_entegrasyonlar_tetikleyici DEFAULT 'onaylandi'
    CONSTRAINT ck_entegrasyonlar_tetikleyici CHECK (tetikleyici IN ('onaylandi', 'odendi', 'elle')),
  kimlik_turu VARCHAR(8) NOT NULL CONSTRAINT df_entegrasyonlar_kimlik DEFAULT 'yok'
    CONSTRAINT ck_entegrasyonlar_kimlik CHECK (kimlik_turu IN ('yok', 'basic')),
  kullanici_adi NVARCHAR(200) NULL,
  -- AES-256-GCM with ENTEGRASYON_ANAHTARI: version byte, IV, tag, ciphertext. Never the password itself.
  sifre VARBINARY(1024) NULL,
  -- [{ "ad": "…", "deger": "…" }]: extra HTTP headers; not secret.
  basliklar NVARCHAR(MAX) NOT NULL CONSTRAINT df_entegrasyonlar_basliklar DEFAULT N'[]'
    CONSTRAINT ck_entegrasyonlar_basliklar CHECK (ISJSON(basliklar) = 1),
  -- [{ "kaynak": "form.tutar", "alias": "TTR", "deger"?: "…" }] in body order.
  alanlar NVARCHAR(MAX) NOT NULL CONSTRAINT df_entegrasyonlar_alanlar DEFAULT N'[]'
    CONSTRAINT ck_entegrasyonlar_alanlar CHECK (ISJSON(alanlar) = 1),
  zaman_asimi_sn INT NOT NULL CONSTRAINT df_entegrasyonlar_zaman DEFAULT 30
    CONSTRAINT ck_entegrasyonlar_zaman CHECK (zaman_asimi_sn BETWEEN 5 AND 120),
  olusturma DATETIME2(3) NOT NULL CONSTRAINT df_entegrasyonlar_olusturma DEFAULT SYSUTCDATETIME(),
  guncelleme DATETIME2(3) NOT NULL CONSTRAINT df_entegrasyonlar_guncelleme DEFAULT SYSUTCDATETIME(),
  guncelleyen_id INT NULL CONSTRAINT fk_entegrasyonlar_guncelleyen REFERENCES dbo.kullanicilar (id),
  CONSTRAINT ck_entegrasyonlar_xml_kok CHECK (bicim <> 'xml' OR kok IS NOT NULL),
  CONSTRAINT ck_entegrasyonlar_basic CHECK (kimlik_turu = 'yok' OR (kullanici_adi IS NOT NULL AND sifre IS NOT NULL)),
  CONSTRAINT ck_entegrasyonlar_yok CHECK (kimlik_turu = 'basic' OR (kullanici_adi IS NULL AND sifre IS NULL))
);

-- The send queue and its log. A send's body is built when it is tried, from the form and the mapping as
-- they are then; the body of the last attempt and the start of the reply are kept for the administrator.
CREATE TABLE dbo.entegrasyon_gonderimleri (
  id INT IDENTITY(1, 1) NOT NULL CONSTRAINT pk_entegrasyon_gonderimleri PRIMARY KEY,
  entegrasyon_id INT NOT NULL CONSTRAINT fk_entegrasyon_gonderimleri_entegrasyon REFERENCES dbo.entegrasyonlar (id) ON DELETE CASCADE,
  form_id INT NOT NULL CONSTRAINT fk_entegrasyon_gonderimleri_form REFERENCES dbo.masraf_formlari (id),
  tetikleyen VARCHAR(12) NOT NULL CONSTRAINT ck_entegrasyon_gonderimleri_tetikleyen CHECK (tetikleyen IN ('onaylandi', 'odendi', 'elle')),
  -- The administrator who sent it by hand; NULL for the automatic ones.
  kullanici_id INT NULL CONSTRAINT fk_entegrasyon_gonderimleri_kullanici REFERENCES dbo.kullanicilar (id),
  durum VARCHAR(12) NOT NULL CONSTRAINT df_entegrasyon_gonderimleri_durum DEFAULT 'bekliyor'
    CONSTRAINT ck_entegrasyon_gonderimleri_durum CHECK (durum IN ('bekliyor', 'gonderildi', 'hata')),
  deneme INT NOT NULL CONSTRAINT df_entegrasyon_gonderimleri_deneme DEFAULT 0
    CONSTRAINT ck_entegrasyon_gonderimleri_deneme CHECK (deneme >= 0),
  http_durum INT NULL,
  -- A short, cleaned message: never the password or the Authorization header.
  son_hata NVARCHAR(500) NULL,
  govde NVARCHAR(MAX) NULL,
  icerik_turu VARCHAR(200) NULL,
  yanit NVARCHAR(2000) NULL,
  sonraki_deneme DATETIME2(3) NULL,
  olusturma DATETIME2(3) NOT NULL CONSTRAINT df_entegrasyon_gonderimleri_olusturma DEFAULT SYSUTCDATETIME(),
  gonderim DATETIME2(3) NULL
);
-- The send job picks the sends that are due: durum = 'bekliyor' AND sonraki_deneme <= now.
CREATE INDEX ix_entegrasyon_gonderimleri_sira ON dbo.entegrasyon_gonderimleri (durum, sonraki_deneme, id);
-- The administrators' log, newest first, and its filters.
CREATE INDEX ix_entegrasyon_gonderimleri_olusturma ON dbo.entegrasyon_gonderimleri (olusturma DESC, id DESC);
CREATE INDEX ix_entegrasyon_gonderimleri_entegrasyon ON dbo.entegrasyon_gonderimleri (entegrasyon_id, id DESC);
CREATE INDEX ix_entegrasyon_gonderimleri_form ON dbo.entegrasyon_gonderimleri (form_id);

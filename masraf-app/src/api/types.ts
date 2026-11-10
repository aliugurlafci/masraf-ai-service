/**
 * Types of the server contract (docs/onay-sistemi.md, sections 5–6). Field names stay Turkish, exactly as
 * the server sends them. Dates are `YYYY-MM-DD`, times are ISO 8601 UTC strings, amounts are numbers.
 */

export type Rol = 'calisan' | 'muhasebe' | 'yonetici';

/**
 * How a flow routes an expense (contract section 2). `zincir`: everyone in order up to the deciding
 * approver (the first whose limit covers the amount) approves. `tek`: only the deciding approver does.
 */
export type Strateji = 'zincir' | 'tek';

export type MasrafDurum = 'taslak' | 'onayda' | 'onaylandi' | 'reddedildi' | 'odendi' | 'iptal';

export type AdimDurum = 'sirada' | 'bekliyor' | 'onaylandi' | 'reddedildi' | 'atlandi' | 'iptal';

export type GecmisIslem =
  | 'olusturuldu'
  | 'guncellendi'
  | 'gonderildi'
  | 'onaylandi'
  | 'reddedildi'
  | 'atlandi'
  | 'tamamlandi'
  | 'geri_cekildi'
  | 'iptal_edildi'
  | 'odendi'
  | 'devredildi';

export type KategoriSimge =
  | 'yemek'
  | 'ulasim'
  | 'konaklama'
  | 'akaryakit'
  | 'ofis'
  | 'temsil'
  | 'egitim'
  | 'iletisim'
  | 'diger';

/** Error body: `{"hata": {...}}`. `mesaj` is always Turkish and safe to show. */
export interface HataGovdesi {
  readonly hata: {
    readonly kod: string;
    readonly mesaj: string;
    readonly alanlar?: Readonly<Record<string, string>>;
    readonly sorunlar?: readonly string[];
  };
}

export interface KisiOzet {
  readonly id: number;
  readonly adSoyad: string;
}

/** An approval flow by name. Each user's expenses go to one flow; one flow is the default. */
export interface AkisOzet {
  readonly id: number;
  readonly ad: string;
  readonly varsayilan: boolean;
}

/** One flow the user approves in: their order, approval limit and the amounts that reach them there. */
export interface OnayciYeri {
  readonly akis: { readonly id: number; readonly ad: string; readonly strateji: Strateji };
  readonly sira: number;
  /** Largest amount (inclusive) they give the last approval for; null = no limit (the flow's last approver). */
  readonly limit: number | null;
  /** Expenses of these amounts (inclusive) come to them; a null upper limit means no upper end. */
  readonly altLimit: number;
  readonly ustLimit: number | null;
}

/** The organisation an admin assigned to the user; a form carries its owner's (contract section 3). */
export interface OrganizasyonOzet {
  readonly id: number;
  readonly kod: string;
  readonly ad: string;
  readonly aktif: boolean;
}

/** A cost centre. `gosterim` is what the user sees ("kod – açıklama", or just the code). */
export interface MasrafMerkeziOzet {
  readonly id: number;
  readonly kod: string;
  readonly aciklama: string | null;
  readonly gosterim: string;
  readonly aktif: boolean;
}

export interface Kullanici {
  readonly id: number;
  readonly eposta: string;
  readonly adSoyad: string;
  readonly rol: Rol;
  readonly departman: string | null;
  readonly aktif: boolean;
  readonly sifreDegismeli: boolean;
  readonly olusturma: string;
  readonly sonGiris: string | null;
  /** The flow the user is assigned to; null = follows the default flow. */
  readonly onayAkisiId: number | null;
  /** The flow the user's expenses go to now (the server always fills it). */
  readonly onayAkisi: AkisOzet | null;
  /** The flows the user approves in; empty when none. */
  readonly onaycilik: readonly OnayciYeri[];
  /** Whether notifications also come by e-mail (the user's choice; in-app notifications cannot be turned off). */
  readonly mailBildirim: boolean;
  /** Null when the admin assigned none. */
  readonly organizasyon: OrganizasyonOzet | null;
  /** Cost centres assigned to the user, by code; empty when none. Only active ones can be picked on a form. */
  readonly masrafMerkezleri: readonly MasrafMerkeziOzet[];
}

// --- Receipt fields (contract section 3, "Fiş alanları"; section 6, "Fiş alanları") ---

/**
 * kategori and masraf_merkezi are the form fields; fatura are the read invoice's header fields (their
 * keys are FaturaBasligi keys); the rest are receipt fields the sender fills for each receipt.
 */
export type AlanTuru = 'kategori' | 'masraf_merkezi' | 'fatura' | 'liste' | 'metin' | 'uzun_metin' | 'sayi' | 'tarih';

export interface AlanTanimi {
  readonly id: number;
  /** Stable key: what `fisAlanlari`, `alanlar`, `eksikAlanlar` and the rules use. */
  readonly anahtar: string;
  readonly ad: string;
  /** form: kategori and masrafMerkezi; fis: everything filled per receipt (invoice header fields too). */
  readonly duzey: 'form' | 'fis';
  readonly tur: AlanTuru;
  readonly zorunlu: boolean;
  readonly aktif: boolean;
  readonly sira: number;
  readonly sistem: boolean;
  /** Help text shown beside the field. */
  readonly aciklama: string | null;
  /** Only for liste: active option count; null otherwise. */
  readonly secenekSayisi: number | null;
}

/** "When the condition field has this value, these fields are required." */
export interface AlanKurali {
  readonly id: number;
  /** `kategori`, `masrafMerkezi` or the key of a liste receipt field. */
  readonly kosulAlan: string;
  readonly kosulDeger: { readonly id: number; readonly gosterim: string; readonly aktif: boolean };
  /** Field keys (only active ones in GET /api/alanlar). */
  readonly hedefler: readonly string[];
}

/** GET /api/alanlar (without tumu): active fields only, rules reduced to active fields. */
export interface AlanlarYaniti {
  readonly alanlar: readonly AlanTanimi[];
  readonly kurallar: readonly AlanKurali[];
}

/** One option of a liste field. */
export interface Secenek {
  readonly id: number;
  readonly kod: string;
  readonly ad: string | null;
  readonly gosterim: string;
  readonly aktif: boolean;
  readonly sira: number;
}

export interface SecenekListesi {
  readonly kayitlar: readonly Secenek[];
  readonly toplam: number;
  readonly sayfa: number;
  readonly adet: number;
}

/**
 * A receipt field's value as the server returns it. `deger` goes back in requests: the option id for
 * liste, a number for sayi, text otherwise (tarih YYYY-AA-GG). `gosterim` is what the user sees.
 */
export interface AlanDegeri {
  readonly deger: number | string;
  readonly gosterim: string;
}

/** Receipt field values by field key (only active fields; fatura header fields are not among them). */
export type AlanDegerleri = Readonly<Record<string, AlanDegeri>>;

/** A value as a request carries it in `fisAlanlari`; null (or empty text) deletes it. */
export type FisDegeri = number | string | null;

export interface Kategori {
  readonly id: number;
  readonly ad: string;
  /** Known values are KategoriSimge; anything else falls back to a generic icon. */
  readonly simge: string | null;
  readonly aktif: boolean;
  readonly sira: number;
}

export interface KategoriOzet {
  readonly id: number;
  readonly ad: string;
  readonly simge: string | null;
}

/** Background reading of a form's invoice files (contract section 3, "Arka planda okuma"). */
export interface OkumaOzeti {
  /** Files queued or being read. */
  readonly bekleyen: number;
  /** Files that could not be read. */
  readonly hatali: number;
}

export interface MasrafOzet {
  readonly id: number;
  readonly baslik: string;
  readonly kategori: KategoriOzet;
  readonly masrafTarihi: string;
  readonly satici: string | null;
  /** Null only on a draft whose amount was left empty; the server fills it once the invoices are read. */
  readonly tutar: number | null;
  readonly paraBirimi: string;
  /** Null exactly when tutar is. */
  readonly yerelTutar: number | null;
  readonly durum: MasrafDurum;
  readonly olusturan: KisiOzet;
  readonly olusturma: string;
  readonly gonderim: string | null;
  /** null unless durum is onayda. */
  readonly siradakiOnayci: KisiOzet | null;
  /** The form's invoices in the order they were added; empty for a form without an invoice. */
  readonly faturaIdler: readonly string[];
  /** Null when the form has no pending invoice file. */
  readonly okuma: OkumaOzeti | null;
  /** Null when none was chosen. */
  readonly masrafMerkezi: MasrafMerkeziOzet | null;
  /** The owner's organisation (updated on every save of the owner until the form is sent); null when none. */
  readonly organizasyon: OrganizasyonOzet | null;
}

/** Where a pending invoice file stands: queued for a reader, being read, or failed. */
export type BekleyenDurum = 'sirada' | 'okunuyor' | 'hata';

/**
 * An invoice file saved on the form but not read (yet). The server reads it in the background and, once
 * read, moves it to the form's invoices (contract section 3).
 */
export interface BekleyenFatura {
  /** SHA-256 of the file, 64 lowercase hex characters; what `bekleyenFaturalar` carries. */
  readonly dosyaOzeti: string;
  readonly dosyaAdi: string;
  readonly mime: string;
  readonly boyut: number;
  readonly eklenme: string;
  readonly durum: BekleyenDurum;
  /** Place among the files waiting for Claude (1 = next); only while sirada and known, else null. */
  readonly kuyrukSirasi: number | null;
  /** Files read before this one, including those being read now; set together with kuyrukSirasi. */
  readonly onundeki: number | null;
  /** Set while durum is hata. */
  readonly hata: { readonly kod: string; readonly mesaj: string } | null;
  /** Receipt field values entered for this file; they move to the invoice once it is read. */
  readonly alanlar: AlanDegerleri;
  /** Required receipt fields that are empty (invoice header fields are not known before reading). */
  readonly eksikAlanlar: readonly string[];
}

export interface MasrafFatura {
  readonly id: string;
  /**
   * SHA-256 (lowercase hex) of the file the invoice was read from: the same value as a pending invoice's
   * `dosyaOzeti`, so it tells which pending file became this invoice. Null only for old records.
   */
  readonly dosyaOzeti: string | null;
  readonly dosyaAdi: string | null;
  readonly dosyaVar: boolean;
  readonly mime: string | null;
  readonly faturaNo: string | null;
  readonly faturaTarihi: string | null;
  readonly saticiUnvan: string | null;
  readonly genelToplam: number | null;
  readonly paraBirimi: string | null;
  /** The invoice is in a third currency (neither the form's nor the base one): sending needs yerelKarsilik. */
  readonly karsilikGerekli: boolean;
  /** Base-currency equivalent the sender entered; only set while karsilikGerekli. */
  readonly yerelKarsilik: number | null;
  // The fields above and below are the invoice's EFFECTIVE information (the correction when there is one).
  readonly saticiVergiNo: string | null;
  readonly aliciUnvan: string | null;
  readonly aliciVergiNo: string | null;
  readonly araToplam: number | null;
  readonly kdvToplam: number | null;
  readonly kalemler: readonly FaturaKalemi[];
  /** The user corrected this invoice on this form. */
  readonly duzeltildi: boolean;
  /** The read result when duzeltildi; null otherwise. */
  readonly okunan: OkunanFatura | null;
  /** Receipt field values (active fields, header fields excluded); {} when none. */
  readonly alanlar: AlanDegerleri;
  /**
   * Required fields that are empty: first the header fields empty in the effective information (schema
   * order), then the receipt fields (by order). Keys of AlanTanimi.
   */
  readonly eksikAlanlar: readonly string[];
}

/** The invoice header fields required out of the box (the admin can change the set). */
export type ZorunluAlan = 'faturaNo' | 'faturaTarihi' | 'saticiUnvan' | 'genelToplam';

/**
 * Declared amount vs. invoices, both in the form's own currency (`paraBirimi`). `fatura` is the total of
 * the invoices that count (contract rule 6): base-currency amounts (base-currency invoices and entered
 * equivalents) are converted with the form rate; an invoice whose equivalent is missing does not count.
 */
export interface TutarFarki {
  readonly fatura: number;
  readonly beyan: number;
}

export interface FormOnay {
  readonly id: number;
  readonly tur: number;
  readonly sira: number;
  readonly onayci: KisiOzet;
  /** The amounts that reached this approver in the flow when the form was sent; null upper = no upper end. */
  readonly altLimit: number;
  readonly ustLimit: number | null;
  readonly durum: AdimDurum;
  readonly aciklama: string | null;
  readonly kararTarihi: string | null;
  /** True when the step went to a fallback manager (rule 8). */
  readonly yedek: boolean;
}

export interface GecmisKaydi {
  readonly islem: GecmisIslem;
  readonly kullanici: KisiOzet | null;
  readonly aciklama: string | null;
  readonly tarih: string;
}

/** What the signed-in user may do on this form. Buttons follow this; the app computes no rules itself. */
export interface Izinler {
  readonly duzenle: boolean;
  readonly gonder: boolean;
  readonly geriCek: boolean;
  readonly iptal: boolean;
  readonly onayla: boolean;
  readonly reddet: boolean;
  readonly odendi: boolean;
  readonly devret: boolean;
}

export interface MasrafDetay extends MasrafOzet {
  readonly aciklama: string | null;
  readonly kur: number | null;
  /**
   * Local-currency amount the form was routed with at its last submission; null for a form never sent.
   * It is not recomputed when a returned form is edited, so it can be out of date for drafts.
   */
  readonly onayTutari: number | null;
  readonly tur: number;
  readonly sonuclanma: string | null;
  readonly odeme: string | null;
  readonly guncelleme: string;
  /** The server sends the form to approval by itself once no pending invoice is left. */
  readonly okununcaGonder: boolean;
  /** Required form fields that are empty; for now only "masrafMerkezi". */
  readonly eksikAlanlar: readonly string[];
  /** Invoice files not read yet, in the order they were added; empty when none. */
  readonly bekleyenFaturalar: readonly BekleyenFatura[];
  /** In the order they were added (same order as faturaIdler); empty for a form without an invoice. */
  readonly faturalar: readonly MasrafFatura[];
  readonly tutarFarki: TutarFarki | null;
  /** Steps of the latest round only, ordered by sira. */
  readonly onaylar: readonly FormOnay[];
  /** Oldest first. */
  readonly gecmis: readonly GecmisKaydi[];
  readonly izinler: Izinler;
}

// --- Session and profile ---

export interface OturumIstegi {
  readonly eposta: string;
  readonly sifre: string;
  readonly istemci: 'mobil';
}

export interface OturumYaniti {
  /** Present for istemci "mobil" and "api". */
  readonly token?: string;
  readonly bitis: string;
  readonly kullanici: Kullanici;
}

export interface BenYaniti {
  readonly kullanici: Kullanici;
  readonly bekleyenOnay: number;
  readonly okunmamisBildirim: number;
}

export interface TercihIstegi {
  readonly mailBildirim: boolean;
}

// --- Notifications ---

export type BildirimTuru =
  | 'onay_bekliyor'
  | 'hatirlatma'
  | 'devredildi'
  | 'onaylandi'
  | 'reddedildi'
  | 'odendi'
  | 'odeme_bekliyor'
  /** Background reading of the form's invoices finished; all were read. */
  | 'okuma_bitti'
  /** Background reading finished; some files could not be read. */
  | 'okuma_hatasi'
  /** "Okununca gönder": the server sent the form to approval. */
  | 'onaya_gonderildi'
  /** "Okununca gönder": a send check failed; the message says why. */
  | 'onaya_gonderilemedi';

export interface Bildirim {
  readonly id: number;
  readonly tur: BildirimTuru;
  readonly baslik: string;
  readonly mesaj: string;
  readonly form: { readonly id: number; readonly baslik: string } | null;
  readonly olusturma: string;
  readonly okundu: boolean;
}

export interface BildirimListesi {
  readonly kayitlar: readonly Bildirim[];
  readonly toplam: number;
  readonly okunmamis: number;
  readonly sayfa: number;
  readonly adet: number;
}

export interface SifreDegistirIstegi {
  readonly mevcutSifre: string;
  readonly yeniSifre: string;
}

export interface Ozet {
  readonly paraBirimi: string;
  readonly benim: {
    readonly taslak: number;
    readonly onayda: number;
    readonly onaylandi: number;
    readonly reddedildi: number;
    readonly odendi: number;
    readonly buAyToplam: number;
    readonly bekleyenTutar: number;
  };
  readonly bekleyenOnay: number;
  readonly sonMasraflar: readonly MasrafOzet[];
  /** Only for muhasebe and yonetici; null otherwise. */
  readonly genel: {
    readonly onayda: number;
    readonly odemeBekleyen: number;
    readonly odemeBekleyenTutar: number;
    readonly buAyOnaylanan: number;
  } | null;
}

// --- Approval flow preview ---

export interface OnizlemeIstegi {
  readonly tutar: number;
  readonly paraBirimi?: string;
  readonly kur?: number;
  /** Invoices whose totals count toward the approval amount (only the user's own uploads count). */
  readonly faturaIdler?: readonly string[];
  /** Base-currency equivalents by invoice id, for invoices in a third currency. */
  readonly yerelKarsiliklar?: Readonly<Record<string, number>>;
  /** Corrections by invoice id, so the approval amount follows the corrected totals. */
  readonly faturaDuzeltmeleri?: Readonly<Record<string, OkunanFatura | null>>;
}

export interface OnizlemeAdimi {
  readonly sira: number;
  readonly onayci: KisiOzet;
  readonly durum: AdimDurum;
  readonly yedek: boolean;
}

export interface Onizleme {
  readonly onayTutari: number;
  readonly paraBirimi: string;
  /** The flow the expense would go to (the sender's own). */
  readonly akis: AkisOzet | null;
  readonly adimlar: readonly OnizlemeAdimi[];
  /** Set when nobody could approve such an expense. */
  readonly uyari: string | null;
}

// --- Expense forms ---

export type Kapsam = 'benim' | 'tumu';

export interface MasrafListeSorgusu {
  readonly kapsam?: Kapsam;
  readonly durum?: readonly MasrafDurum[];
  readonly q?: string;
  readonly sayfa?: number;
  readonly adet?: number;
}

export interface MasrafListesi {
  readonly kayitlar: readonly MasrafOzet[];
  readonly toplam: number;
  readonly sayfa: number;
  readonly adet: number;
}

export interface MasrafAlanlari {
  readonly baslik: string;
  readonly kategoriId: number;
  readonly masrafTarihi: string;
  /**
   * Required to send. A draft may leave it out (POST) or clear it with null (PATCH, only a `taslak`); the
   * server fills it from the invoices once they are read.
   */
  readonly tutar?: number | null;
  readonly paraBirimi?: string;
  readonly kur?: number | null;
  readonly satici?: string | null;
  readonly aciklama?: string | null;
  /**
   * At most 20 distinct invoice ids, in order. On PATCH the list replaces the form's invoices entirely
   * (`[]` removes them all); leave it out to keep them unchanged.
   */
  readonly faturaIdler?: readonly string[];
  /**
   * Base-currency equivalents by invoice id (> 0, at most 2 decimals), only for invoices on the form. On
   * PATCH the map replaces every equivalent; leave it out to keep those of the invoices that stay.
   */
  readonly yerelKarsiliklar?: Readonly<Record<string, number>>;
  /**
   * Corrections by invoice id: the invoice's whole schema, or null to go back to the read result. Only
   * listed invoices change; only invoices on the form may be listed.
   */
  readonly faturaDuzeltmeleri?: Readonly<Record<string, OkunanFatura | null>>;
  /**
   * SHA-256 of the files still being read (`dosyaOzeti`), each once. Replaces the form's pending invoices
   * entirely; leave it out to keep them. Whenever faturaIdler goes, this goes too, so an invoice read
   * meanwhile is not dropped from the list (contract section 6, rule 3).
   */
  readonly bekleyenFaturalar?: readonly string[];
  /** Send the form to approval once no pending invoice is left. Never together with `gonder: true`. */
  readonly okununcaGonder?: boolean;
  /**
   * An active cost centre assigned to the owner, or null. Only while the masrafMerkezi field is active
   * (else 400). The form's stored value may be sent again even if it became inactive. PATCH: leave it
   * out to keep it; POST: left out, the owner's single active cost centre is chosen.
   */
  readonly masrafMerkeziId?: number | null;
  /**
   * Receipt field values by receipt: an invoice id for a read invoice, a file's SHA-256 for a file still
   * being read (it also finds the invoice that file became). Each listed receipt's values are replaced
   * as a whole (active fields left out are deleted); receipts not listed keep theirs.
   */
  readonly fisAlanlari?: Readonly<Record<string, Readonly<Record<string, FisDegeri>>>>;
}

export interface MasrafOlusturIstegi extends MasrafAlanlari {
  readonly gonder?: boolean;
}

export type MasrafGuncelleIstegi = Partial<MasrafAlanlari>;

export type OnayListeDurumu = 'bekleyen' | 'karar';

// --- Invoice reading (existing multi-file endpoints) ---

export type OkumaDurumu = 'sirada' | 'okunuyor' | 'bitti' | 'hata';

export interface FaturaBasligi {
  readonly faturaNo: string | null;
  readonly faturaTarihi: string | null;
  readonly saticiUnvan: string | null;
  readonly saticiVergiNo: string | null;
  readonly aliciUnvan: string | null;
  readonly aliciVergiNo: string | null;
  readonly paraBirimi: string | null;
  readonly araToplam: number | null;
  readonly kdvToplam: number | null;
  readonly genelToplam: number | null;
}

export interface FaturaKalemi {
  readonly aciklama: string | null;
  readonly miktar: number | null;
  readonly birim: string | null;
  readonly birimFiyat: number | null;
  readonly kdvOrani: number | null;
  readonly tutar: number | null;
}

export interface OkunanFatura {
  readonly fatura: FaturaBasligi;
  readonly kalemler: readonly FaturaKalemi[];
}

export interface KuyrukDosyasi {
  readonly sira: number;
  readonly dosyaAdi: string;
  /** SHA-256 of the file; null for a file the server rejected. Saved as a pending invoice by this value. */
  readonly dosyaOzeti: string | null;
  readonly durum: OkumaDurumu;
  /** Place among the files waiting for Claude (1 = next) while sirada; else null. */
  readonly kuyrukSirasi: number | null;
  /** Files read before this one, including those being read now; set together with kuyrukSirasi. */
  readonly onundeki: number | null;
  readonly kayitId: string | null;
  readonly onbellek: boolean;
  readonly hata: { readonly kod: string; readonly mesaj: string } | null;
  readonly sonuc: OkunanFatura | null;
}

export interface Kuyruk {
  readonly id: string;
  readonly olusturulma: string;
  readonly bitti: boolean;
  readonly esZamanli: number;
  readonly sayac: Readonly<Record<OkumaDurumu | 'toplam', number>>;
  readonly dosyalar: readonly KuyrukDosyasi[];
}

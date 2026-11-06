/**
 * Types of the server contract (docs/onay-sistemi.md, sections 5–6). Field names stay Turkish, exactly as
 * the server sends them. Dates are `YYYY-MM-DD`, times are ISO 8601 UTC strings, amounts are numbers.
 */

export type Rol = 'calisan' | 'muhasebe' | 'yonetici';

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

/** One flow the user approves in, with their order and amount range there. */
export interface OnayciYeri {
  readonly akis: { readonly id: number; readonly ad: string };
  readonly sira: number;
  readonly altLimit: number;
  /** null means unlimited. */
  readonly ustLimit: number | null;
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
}

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

export interface MasrafOzet {
  readonly id: number;
  readonly baslik: string;
  readonly kategori: KategoriOzet;
  readonly masrafTarihi: string;
  readonly satici: string | null;
  readonly tutar: number;
  readonly paraBirimi: string;
  readonly yerelTutar: number;
  readonly durum: MasrafDurum;
  readonly olusturan: KisiOzet;
  readonly olusturma: string;
  readonly gonderim: string | null;
  /** null unless durum is onayda. */
  readonly siradakiOnayci: KisiOzet | null;
  /** The form's invoices in the order they were added; empty for a form without an invoice. */
  readonly faturaIdler: readonly string[];
}

export interface MasrafFatura {
  readonly id: string;
  readonly dosyaAdi: string | null;
  readonly dosyaVar: boolean;
  readonly mime: string | null;
  readonly faturaNo: string | null;
  readonly faturaTarihi: string | null;
  readonly saticiUnvan: string | null;
  readonly genelToplam: number | null;
  readonly paraBirimi: string | null;
}

/**
 * Declared amount vs. invoices, both in the form's own currency (`paraBirimi`). `fatura` is the sum of the
 * invoices in the form's currency (or whose currency was not read); invoices in other currencies are left out.
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
  readonly onayTutari: number;
  readonly tur: number;
  readonly sonuclanma: string | null;
  readonly odeme: string | null;
  readonly guncelleme: string;
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
  readonly tutar: number;
  readonly paraBirimi?: string;
  readonly kur?: number | null;
  readonly satici?: string | null;
  readonly aciklama?: string | null;
  /**
   * At most 20 distinct invoice ids, in order. On PATCH the list replaces the form's invoices entirely
   * (`[]` removes them all); leave it out to keep them unchanged.
   */
  readonly faturaIdler?: readonly string[];
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
  readonly durum: OkumaDurumu;
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

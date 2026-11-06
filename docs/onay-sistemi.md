# Masraf formları ve onay sistemi: tasarım ve API sözleşmesi

Bu belge web paneli, mobil uygulama (`masraf-app/`) ve sunucu için tek kaynaktır. Sözleşme değişirse önce bu belge güncellenir.

## 1. Kavramlar

| Kavram | Açıklama |
|---|---|
| Kullanıcı | E-posta ve şifreyle giriş yapar. Rolü `calisan`, `muhasebe` ya da `yonetici`dir. |
| Fatura kaydı | Claude'un okuduğu fatura (`{fatura, kalemler}`), orijinal dosyasıyla birlikte veritabanında saklanır. Aynı dosya (SHA-256) ikinci kez okunmaz. |
| Masraf formu | Çalışanın onaya sunduğu masraf. Bir başlık, kategori, tarih, tutar ve isteğe bağlı olarak bir ya da birden çok (en çok 20) fatura kaydından oluşur. Örneğin bir iş seyahatinin otel, taksi ve yemek fişleri tek formda toplanabilir. |
| Onay akışı | Adı olan, sıralı bir onaycı listesi. Her onaycının bir onay limiti vardır; akışın stratejisi (zincirleme onay ya da tek onaycı) masrafı kimlerin onaylayacağını belirler. Şirkette birden çok akış olabilir, biri varsayılandır. |
| Akış ataması | Kullanıcının masraflarının hangi akışla onaylanacağı. Atanmamış kullanıcı varsayılan akışı kullanır. |
| Onay adımı | Gönderilen bir formun, gönderenin akışından kopyalanan onaycılarından biri. |

### Roller

| Yetki | calisan | muhasebe | yonetici |
|---|:-:|:-:|:-:|
| Fatura okutma, kendi masraf formları | ✓ | ✓ | ✓ |
| Kendisine gelen onaylar (akışta yer alıyorsa) | ✓ | ✓ | ✓ |
| Tüm formları görme, CSV dışa aktarma, "ödendi" işaretleme | | ✓ | ✓ |
| Tüm faturaları ve canlı izlemenin tamamını görme | | ✓ | ✓ |
| Kullanıcı, kategori ve onay akışı yönetimi, akış ataması, onay devretme | | | ✓ |

Onaycılık bir rol değildir. Her rolden aktif kullanıcı bir ya da birden çok onay akışına eklenebilir.

## 2. Onay akışları

Şirkette birden çok onay akışı tanımlanabilir. Böylece her kullanıcının masrafı farklı onaycılara ve farklı tutar aralıklarına göre yönlenebilir. Örneğin satış ekibi "Satış" akışına, yönetim kadrosu "Yönetim" akışına atanır, diğer herkes varsayılan akışı kullanır.

- **Varsayılan akış:** Her zaman tam bir akış varsayılandır. İlk kurulumda "Genel" adıyla oluşur. Varsayılan akış silinemez. Başka bir akış varsayılan yapıldığında eski varsayılan sıradan bir akışa döner.
- **Atama:** Yönetici kullanıcıyı bir akışa atar (`onayAkisiId`). `null` olan kullanıcı varsayılan akışı kullanır ve varsayılan değişirse yenisini izler. Bir akışa açıkça atanmış kullanıcı, o akış varsayılan olmaktan çıksa da onda kalır.
- **Akış adı** 1–80 karakterdir ve benzersizdir (büyük/küçük harf ayrımı yapılmaz).
- **Silme:** Varsayılan olmayan akış silinebilir. Ona atanmış kullanıcılar varsayılan akışa geçer (`onayAkisiId: null`). Süren formlar etkilenmez (kural 9).

Her onay akışı sıralı bir onaycı listesidir. Her onaycının bir **onay limiti** vardır: son onayını verebileceği en yüksek tutar (dahil). Limitler sırayla büyür; son onaycının limiti sınırsızdır. Böylece her tutar için limiti o tutara yeten tam bir onaycı bulunur: **karar veren onaycı**. Akışın **stratejisi**, masrafı karar verenden başka kimin göreceğini belirler:

- **Zincirleme onay (`zincir`):** Masraf ilk onaycıdan başlar ve karar veren onaycıya kadar sıradaki herkesin onayından geçer. Tutar büyüdükçe zincir uzar.
- **Tek onaycı (`tek`):** Masrafı yalnızca karar veren onaycı onaylar. Her tutar aralığının kendi onaycısı vardır.

| Sıra | Onaycı | Onay limiti | Zincirleme onayda | Tek onaycıda |
|---|---|---|---|---|
| 1 | Ayşe (birim) | 5.000,00 | 5.000'e kadar: Ayşe | 5.000'e kadar: Ayşe |
| 2 | Mehmet (finans) | 50.000,00 | 5.000,01 – 50.000: Ayşe → Mehmet | 5.000,01 – 50.000: Mehmet |
| 3 | Zeynep (GM) | sınırsız | 50.000 üzeri: Ayşe → Mehmet → Zeynep | 50.000 üzeri: Zeynep |

Kurallar:

1. **En az bir onaycı zorunludur.** Hiçbir akış boş kalamaz. İlk yönetici oluşturulurken varsayılan akış o yöneticiyle (limiti sınırsız) başlar. Yeni akışın stratejisi belirtilir; ilk kurulumdaki "Genel" akışı zincirleme onaydır.
2. **Onay limiti:** Kuruş hassasiyetindedir ve dahildir: limiti 5.000 olan onaycı tam 5.000'lik masrafın da son onayını verir, 5.000,01 bir sonrakine geçer. Son onaycı dışındaki her onaycının limiti 0'dan büyüktür ve bir öncekinden büyük olmalıdır. Son onaycının limiti sınırsızdır (`limit: null`). Bu kurallar her tutarın tam bir karar veren onaycısı olmasını sağlar; aralık boşluğu ya da çakışması oluşamaz. Kurala uymayan akış kaydedilmez (`400 gecersiz_akis`, sorunlar Türkçe listelenir).
3. **Sıra = yetki sırası.** Onaycılar küçük limitten büyüğe dizilir. Zincirleme onayda masraf bu sırayla ilerler.
4. **Bir kullanıcı bir akışta bir kez** yer alır, farklı akışlarda ayrı limitlerle yer alabilir. Onaycı aktif olmalıdır.
5. **Yönlendirme:** Form, **gönderenin akışına** (atanmış akış, yoksa varsayılan akış) göre yönlenir: karar veren onaycı onay tutarına göre bulunur, stratejiye göre ondan önceki onaycılar da eklenir ve hepsi **sırayla** onaylar. Hangi akışın kullanıldığı gönderim anında belirlenir ve form geçmişine yazılır. Örnekte zincirleme onayda 3.000 ₺ yalnızca Ayşe'ye, 20.000 ₺ önce Ayşe'ye sonra Mehmet'e, 80.000 ₺ üçüne de gider; tek onaycıda 20.000 ₺ yalnızca Mehmet'e gider.
6. **Onay tutarı:** Formun yerel para birimindeki (`PARA_BIRIMI`) tutarı ile bağlı faturaların yerel para birimindeki toplamından büyük olanıdır. Her faturanın yerel değeri şöyle bulunur:
   - Formla aynı para birimindeki (ya da para birimi okunamamış) fatura: genel toplamı × formun kuru.
   - Yerel para birimindeki fatura: genel toplamının kendisi.
   - Başka bir para birimindeki fatura: gönderenin girdiği yerel karşılık (`yerelKarsilik`). Karşılığı girilmemiş böyle bir fatura varken form onaya gönderilemez (`409 karsilik_eksik`); taslak olarak kaydedilebilir.

   Toplama genel toplamı (ya da karşılığı) sıfırdan büyük olan faturalar girer. Faturaların altında beyan edilen bir form daha düşük bir onay kademesine kaçamaz. İki tutar farklıysa onaycılar bunu formda uyarı olarak görür (`tutarFarki`).
7. **Para birimi:** Onay limitleri `.env` içindeki `PARA_BIRIMI` (varsayılan `TRY`) cinsindendir. Başka para birimindeki formda kur zorunludur. Yerel tutar, tutar × kur olarak hesaplanır.
8. **Kendi masrafı:** Kimse kendi masrafını onaylamaz. Gönderen, masrafın geçtiği onaycılardan biriyse onun adımı `atlandi` olur. Gönderen karar veren onaycıysa son onay **bir üst onaycıya** geçer (akışta ondan sonraki onaycı). Gönderen akışın en üstündeyse son onay, gönderen dışındaki ve bu masrafı zaten onaylamayan ilk aktif yöneticiye (`yedek: true`) gider; kimse aynı masrafı iki kez onaylamaz. Böyle biri de yoksa ve masrafı onaylayacak başka kimse kalmadıysa gönderim `409 onaylayan_yok` ile reddedilir. Örnekte Mehmet'in 20.000 ₺'lik masrafı zincirleme onayda Ayşe'ye, sonra Zeynep'e gider.
9. **Anlık kopya:** Form gönderildiğinde eşleşen adımlar forma kopyalanır. Akış, akışın varsayılanlığı ya da kullanıcının ataması sonradan değişse de süren formlar etkilenmez.
10. **Herhangi bir akışta onaycı olan kullanıcı pasifleştirilemez.** Önce o akışlardan çıkarılmalıdır. Bekleyen onayı olan kullanıcı da pasifleştirilemez; yönetici önce onayları devreder. Pasif kullanıcının akış ataması korunur.

## 3. Formun yaşam döngüsü

```
taslak ──gönder──▶ onayda ──son adım onay──▶ onaylandi ──ödendi──▶ odendi
  ▲  │               │ │
  │  └──iptal──▶ iptal │ └──bir adım ret──▶ reddedildi ──düzenle + gönder──▶ onayda (yeni tur)
  └────geri çek───────┘                        └──iptal──▶ iptal
```

| İşlem | Kim | Hangi durumda | Sonuç |
|---|---|---|---|
| Düzenle | sahibi | `taslak`, `reddedildi` | Alanlar güncellenir, durum değişmez |
| Gönder | sahibi | `taslak`, `reddedildi` | `tur` bir artar, adımlar sahibinin akışından kopyalanır, ilk adım `bekliyor` olur, form `onayda` olur |
| Geri çek | sahibi | `onayda` | Kalan adımlar `iptal`, form `taslak` |
| İptal | sahibi | `taslak`, `reddedildi` | Form `iptal`. Bağlı faturalar başka formda kullanılabilir hale gelir |
| Onayla | sıradaki onaycı | `onayda` | Adım `onaylandi`. Sıradaki adım `bekliyor` olur. Adım kalmadıysa form `onaylandi` |
| Reddet | sıradaki onaycı | `onayda` | Açıklama zorunlu. Adım `reddedildi`, kalan adımlar `iptal`, form `reddedildi` |
| Ödendi | muhasebe, yonetici | `onaylandi` | Form `odendi` |
| Devret | yonetici | `onayda` | Karar verilmemiş bir adımın onaycısı değişir |

Adım durumları: `sirada` (henüz sırası gelmedi) → `bekliyor` (karar bekliyor, yalnızca bir tane) → `onaylandi` / `reddedildi`. Ayrıca `atlandi` (kendi masrafı) ve `iptal` (geri çekildi veya reddedildi).

Ek kurallar:

- Bir forma en çok 20 fatura eklenir ve aynı fatura bir forma iki kez eklenemez. Faturaların sırası eklenme sırasıdır.
- Bir fatura kaydı, iptal edilmemiş en fazla bir formda kullanılabilir (çift beyan koruması). Veritabanında filtreli benzersiz indeksle korunur. İptal edilen formun fatura bağları kayıtta kalır ama faturalar serbest kalır.
- Aynı adım için iki karar aynı anda gelirse yalnızca biri geçer, diğeri `409 onay_beklemiyor` alır.
- Her işlem form geçmişine (`gecmis`) yazılır. Yönetici işlemleri (kullanıcı, akış, kategori) denetim kaydına yazılır.

## 4. Veritabanı (MSSQL)

Docker'daki SQL Server 2022 kullanılır (`docker compose up -d`). Sunucu açılışta veritabanını yoksa oluşturur ve `src/db/migrations/*.sql` dosyalarını sırayla uygular.

| Tablo | İçerik |
|---|---|
| `kullanicilar` | e-posta (benzersiz, küçük harf), ad soyad, rol, departman, şifre özeti (scrypt), aktif, `sifre_degismeli`, atanmış onay akışı (`onay_akisi_id`, boşsa varsayılan) |
| `oturumlar` | Token'ın SHA-256 özeti, kullanıcı, istemci (`panel`/`mobil`/`api`), bitiş. Token'ın kendisi saklanmaz |
| `masraf_kategorileri` | ad, simge, sıra, aktif |
| `onay_akislari` | Akış adı (benzersiz), varsayılan mı (en fazla biri, filtreli benzersiz indeks), son değişiklik ve yapan |
| `onay_adimlari` | Akışın adımları: akış, sıra, onaycı, onay limiti (`NULL` = sınırsız). Sıra ve onaycı akış içinde benzersizdir. Akışın stratejisi `onay_akislari.strateji` alanındadır |
| `form_faturalari` | Formun faturaları: form, fatura kaydı, sıra, `aktif` (form iptal edilince 0), girilen yerel karşılık (`yerel_karsilik`). Bir fatura en fazla bir aktif bağda bulunur |
| `fatura_kayitlari` | Okunan fatura (JSON), ölçüm (JSON), dosya özeti, liste için özet alanlar |
| `fatura_dosyalari` | Orijinal dosya (`VARBINARY(MAX)`) ve MIME türü |
| `fatura_yuklemeleri` | Hangi kullanıcı hangi faturayı ne zaman yükledi. Erişim yetkisi buradan gelir |
| `masraf_formlari` | Form alanları, durum, tur, yerel tutar, onay tutarı |
| `form_onaylari` | Formun her turdaki onay adımları (akıştan kopya) |
| `form_gecmisi` | Formun zaman çizelgesi |
| `denetim_kayitlari` | Yönetici işlemleri |
| `sema_surumleri` | Uygulanan migration'lar |

Tutarlar `DECIMAL(18,2)`, kur `DECIMAL(18,6)`, zamanlar UTC `DATETIME2(3)`'tür. Ad, başlık ve satıcı gibi metinler `Turkish_100_CI_AS` sıralamasıyla saklanır.

## 5. Kimlik doğrulama

- `POST /api/oturum` başarılı girişte bir oturum açar.
  - `istemci: "panel"` ise `HttpOnly; SameSite=Strict` `masraf_oturum` çerezi gönderilir, token gövdede dönmez.
  - `"mobil"` veya `"api"` ise token gövdede döner. İstemci bu token'ı `Authorization: Bearer <token>` başlığıyla gönderir.
- Oturum süresi `OTURUM_SURESI_SAAT` ile ayarlanır ve kullanıldıkça uzar. Şifre değişince kullanıcının diğer oturumları kapanır.
- Arka arkaya hatalı girişte (`GIRIS_DENEME_SINIRI`) e-posta `GIRIS_KILIT_DAKIKA` süresince kilitlenir.
- Yöneticinin oluşturduğu ya da şifresini sıfırladığı kullanıcıda `sifreDegismeli: true` olur. İstemci kullanıcıyı şifre değiştirme ekranına yönlendirir. Şifre değişene kadar yalnızca `GET /api/ben`, `PUT /api/ben/sifre` ve `DELETE /api/oturum` çalışır; diğer uçlar `403 sifre_degismeli` döner.
- Şifre en az `SIFRE_MIN_UZUNLUK` (varsayılan 8), en çok 128 karakterdir ve en az bir harf ile bir rakam içerir.
- `/health` ve `POST /api/oturum` dışındaki bütün `/api` uçları oturum ister. Oturum yoksa `401 oturum_gerekli` döner.
- Kullanıcının göremediği form ya da fatura için `404 bulunamadi` döner; böylece başkasının kayıtlarının varlığı da sızmaz. `403 yetki_yok` yalnızca rolün yetmediği uçlarda (ör. çalışanın `GET /api/kullanicilar` isteği) ya da formu görebilen ama o işlemi yapamayan kişiye döner.
- Panel çerezi de oturumla birlikte uzar: oturum süresi ileri alındığında sunucu çerezi yeni `Max-Age` ile yeniden gönderir.
- Host ve Origin koruması aynen sürer. Sunucu varsayılan olarak yalnızca `127.0.0.1` üzerinde dinler. Mobil uygulama `adb reverse tcp:4000 tcp:4000` ile (Android) ya da iOS simülatöründe `127.0.0.1` üzerinden bağlanır. Gerçek iPhone ya da Wi-Fi'deki telefon için sunucu `AG_ERISIMI=yerel` ile yerel ağa açılır; o zaman yalnızca özel ağ adreslerinden gelen istekler kabul edilir, diğerleri `403 izinsiz_ag` alır.

## 6. API sözleşmesi

Bütün gövdeler JSON'dur. Hata gövdesi `{"hata": {"kod": "...", "mesaj": "...", "alanlar"?: {"alan": "mesaj"}, "sorunlar"?: ["..."]}}` biçimindedir. `mesaj` her zaman Türkçe ve kullanıcıya gösterilebilir. Tarihler `YYYY-MM-DD`, zamanlar ISO 8601 UTC'dir. Tutarlar sayıdır.

### Ortak nesneler

```jsonc
// Kullanici
{ "id": 3, "eposta": "ayse@firma.com", "adSoyad": "Ayşe Kaya", "rol": "calisan", "departman": "Satış",
  "aktif": true, "sifreDegismeli": false, "olusturma": "2026-11-06T09:00:00.000Z", "sonGiris": null,
  "onayAkisiId": null,                                        // atanmış akış; null = varsayılan akışı kullanır
  "onayAkisi": { "id": 1, "ad": "Genel", "varsayilan": true }, // masraflarının şu an gittiği akış (her zaman dolu)
  "onaycilik": [                                              // onaycı olduğu akışlar (varsayılan önce, sonra ada göre); yoksa []
    { "akis": { "id": 1, "ad": "Genel", "strateji": "zincir" }, "sira": 1,
      "limit": 5000,                                          // son onayını verebileceği en yüksek tutar; null = sınırsız
      "altLimit": 0, "ustLimit": null } ] }                   // bu tutar aralığındaki masraflar ona gelir (ustLimit null = üst sınır yok)

// AkisOzet
{ "id": 2, "ad": "Satış", "varsayilan": false }

// KisiOzet
{ "id": 3, "adSoyad": "Ayşe Kaya" }

// Kategori
{ "id": 1, "ad": "Yemek", "simge": "yemek", "aktif": true, "sira": 1 }
// simge: yemek | ulasim | konaklama | akaryakit | ofis | temsil | egitim | iletisim | diger

// MasrafOzet (listelerde)
{ "id": 1001, "baslik": "Müşteri yemeği", "kategori": { "id": 1, "ad": "Yemek", "simge": "yemek" },
  "masrafTarihi": "2026-11-05", "satici": "Örnek Lokanta", "tutar": 1800, "paraBirimi": "TRY", "yerelTutar": 1800,
  "durum": "onayda", "olusturan": { "id": 3, "adSoyad": "Ayşe Kaya" }, "olusturma": "…", "gonderim": "…",
  "siradakiOnayci": { "id": 2, "adSoyad": "Mehmet Demir" },   // durum onayda değilse null
  "faturaIdler": ["20261105-163012-0b9c44d1"] }               // eklenme sırasıyla; faturasız formda []

// MasrafDetay = MasrafOzet + aşağıdakiler
{ "aciklama": "…", "kur": null, "onayTutari": 1800,   // son gönderimdeki onay tutarı; hiç gönderilmemiş formda null "tur": 1, "sonuclanma": null, "odeme": null, "guncelleme": "…",
  "faturalar": [                 // eklenme sırasıyla; faturasız formda []
    { "id": "…", "dosyaAdi": "fis.jpg", "dosyaVar": true, "mime": "image/jpeg", "faturaNo": "…",
      "faturaTarihi": "2026-11-05", "saticiUnvan": "…", "genelToplam": 1800, "paraBirimi": "TRY",
      "karsilikGerekli": false,  // fatura üçüncü bir para biriminde: gönderim için yerelKarsilik gerekir
      "yerelKarsilik": null } ],  // gönderenin girdiği yerel karşılık; yalnızca karsilikGerekli iken dolu
  "tutarFarki": null,            // ya da { "fatura": 1800, "beyan": 1500 } (fatura: toplama giren faturaların toplamı)
  "onaylar": [                   // yalnızca son tur, sıraya göre
    { "id": 10, "tur": 1, "sira": 1, "onayci": { "id": 2, "adSoyad": "Mehmet Demir" }, "altLimit": 0, "ustLimit": null, // onaycının akıştaki tutar aralığı (gönderimdeki kopya)
      "durum": "bekliyor", "aciklama": null, "kararTarihi": null, "yedek": false } ],
  "gecmis": [                    // eskiden yeniye
    { "islem": "gonderildi", "kullanici": { "id": 3, "adSoyad": "Ayşe Kaya" }, "aciklama": null, "tarih": "…" } ],
  "izinler": { "duzenle": false, "gonder": false, "geriCek": true, "iptal": false,
               "onayla": false, "reddet": false, "odendi": false, "devret": false } }
```

`gecmis.islem`: `olusturuldu`, `guncellendi`, `gonderildi`, `onaylandi`, `reddedildi`, `atlandi`, `tamamlandi`, `geri_cekildi`, `iptal_edildi`, `odendi`, `devredildi`.

`izinler` o anki kullanıcının bu formda yapabileceği işlemlerdir. İstemciler düğmeleri buna göre gösterir, kuralları kendileri hesaplamaz.

### Oturum ve profil

| İstek | Gövde | Yanıt |
|---|---|---|
| `POST /api/oturum` | `{ eposta, sifre, istemci?: "panel"\|"mobil"\|"api" }` | `200 { token?, bitis, kullanici }` · `401 hatali_giris` · `403 hesap_pasif` · `429 cok_fazla_deneme` |
| `DELETE /api/oturum` | | `204` |
| `GET /api/ben` | | `{ kullanici, bekleyenOnay }` (rozet sayacı için hafif uç) |
| `PUT /api/ben/sifre` | `{ mevcutSifre, yeniSifre }` | `204` · `400 hatali_sifre` · `400 gecersiz_istek` |
| `GET /api/ozet` | | Gösterge (aşağıda) |

```jsonc
// GET /api/ozet
{ "paraBirimi": "TRY",
  "benim": { "taslak": 1, "onayda": 2, "onaylandi": 5, "reddedildi": 0, "odendi": 9,
             "buAyToplam": 12450.5, "bekleyenTutar": 3200 },   // buAyToplam: son gönderimi bu ay olan ve şu an onayda, onaylandi, reddedildi ya da odendi durumundaki formların yerel tutarı (taslağa geri çekilen ve iptal edilenler sayılmaz)
  "bekleyenOnay": 3,
  "sonMasraflar": [ /* MasrafOzet, en yeni 5 */ ],
  "genel": { "onayda": 7, "odemeBekleyen": 4, "odemeBekleyenTutar": 15200, "buAyOnaylanan": 48200 } }  // yalnızca muhasebe/yonetici, diğerlerinde null
```

### Kullanıcılar (yonetici)

| İstek | Gövde | Yanıt |
|---|---|---|
| `GET /api/kullanicilar?q=&aktif=` | | `Kullanici[]` (ada göre) |
| `POST /api/kullanicilar` | `{ eposta, adSoyad, rol, departman?, sifre, onayAkisiId? }` | `201 Kullanici` · `409 eposta_kullaniliyor` |
| `PATCH /api/kullanicilar/:id` | `{ eposta?, adSoyad?, rol?, departman?, aktif?, onayAkisiId? }` | `Kullanici` · `409 eposta_kullaniliyor` · `409 kendi_hesabi` (kendini pasifleştirme) · `409 son_yonetici` · `409 onay_akisinda` · `409 bekleyen_onay_var` |
| `POST /api/kullanicilar/:id/sifre` | `{ yeniSifre }` | `204` (oturumları kapanır, `sifreDegismeli: true`) |
| `GET /api/denetim?adet=50` | | `[{ id, islem, ayrinti, kullanici: KisiOzet\|null, tarih }]` |

`onayAkisiId` bir akışın kimliği ya da `null`dır (varsayılan akışı kullan). Gönderilmezse değişmez (`POST`'ta `null`). Olmayan bir akış `400 gecersiz_istek` ve `alanlar.onayAkisiId` döner.

### Onay akışları

| İstek | Kim | Gövde | Yanıt |
|---|---|---|---|
| `GET /api/onay-akislari` | yonetici | | `Akis[]` (varsayılan önce, sonra ada göre) |
| `POST /api/onay-akislari` | yonetici | `{ ad, strateji, adimlar: [{ onayciId, limit }] }` (`strateji`: `zincir` ya da `tek`; dizi sırası = onay sırası; son adımın `limit` değeri `null`) | `201 Akis` · `400 gecersiz_akis` (`sorunlar` listesiyle) · `409 akis_adi_kullaniliyor` |
| `GET /api/onay-akislari/:id` | yonetici | | `Akis` · `404 bulunamadi` |
| `PUT /api/onay-akislari/:id` | yonetici | `{ ad, strateji, adimlar }` (akışın tamamı yerine geçer) | `Akis` · `400 gecersiz_akis` · `409 akis_adi_kullaniliyor` |
| `POST /api/onay-akislari/:id/varsayilan` | yonetici | | `Akis` (artık varsayılan) |
| `DELETE /api/onay-akislari/:id` | yonetici | | `204` · `409 varsayilan_akis` (varsayılan silinemez) |
| `POST /api/onay-akisi/onizle` | herkes | `{ tutar, paraBirimi?, kur?, faturaIdler?, yerelKarsiliklar?, akisId? }` | `Onizleme` · `403 yetki_yok` (`akisId` gönderen yönetici değilse) |

```jsonc
// Akis
{ "id": 1, "ad": "Genel", "varsayilan": true, "strateji": "zincir", "paraBirimi": "TRY",
  "guncelleme": "…", "guncelleyen": { "id": 1, "adSoyad": "…" },   // guncelleyen null olabilir
  "kullaniciSayisi": 12,   // masrafları şu an bu akışa giden aktif kullanıcılar (varsayılan akışta atanmamış olanlar dahil)
  "adimlar": [ { "sira": 1, "onayci": { "id": 2, "adSoyad": "…", "eposta": "…", "departman": "…" }, "limit": 5000 },
               { "sira": 2, "onayci": { "id": 5, "adSoyad": "…", "eposta": "…", "departman": null }, "limit": null } ] }

// Onizleme: giriş yapan kullanıcı bu tutarla form gönderseydi
{ "onayTutari": 20000, "paraBirimi": "TRY", "akis": { "id": 2, "ad": "Satış", "varsayilan": false },
  "adimlar": [ { "sira": 1, "onayci": { "id": 2, "adSoyad": "…" }, "durum": "sirada", "yedek": false },
               { "sira": 2, "onayci": { "id": 5, "adSoyad": "…" }, "durum": "sirada", "yedek": false } ],
  "uyari": null }
// Önizlemede durum yalnızca "sirada" ya da "atlandi" (gönderenin kendi adımı) olur; ilk "sirada" adım ilk karar verecek kişidir.
// Kimse onaylayamıyorsa adimlar boş, uyari Türkçe açıklamadır (gönderim 409 onaylayan_yok verir).
// akisId verilmezse kullanıcının kendi akışı kullanılır. Yönetici akisId ile kaydedilmiş başka bir akışı
// kendisi göndermiş gibi deneyebilir (panelin "Tutar dene" kutusu); olmayan akış 404 döner.
```

### Kategoriler

| İstek | Kim | Gövde | Yanıt |
|---|---|---|---|
| `GET /api/kategoriler?tumu=1` | herkes (`tumu` yalnızca yonetici) | | `Kategori[]` |
| `POST /api/kategoriler` | yonetici | `{ ad, simge? }` | `201 Kategori` · `409 kategori_var` |
| `PATCH /api/kategoriler/:id` | yonetici | `{ ad?, simge?, aktif?, sira? }` | `Kategori` |

### Masraf formları

| İstek | Gövde | Yanıt |
|---|---|---|
| `GET /api/masraflar?kapsam=benim\|tumu&durum=onayda,taslak&q=&sayfa=1&adet=20` | | `{ kayitlar: MasrafOzet[], toplam, sayfa, adet }` (`tumu` yalnızca muhasebe/yonetici) |
| `POST /api/masraflar` | `{ baslik, kategoriId, masrafTarihi, tutar, paraBirimi?, kur?, satici?, aciklama?, faturaIdler?, yerelKarsiliklar?, gonder? }` | `201 MasrafDetay` · `409 fatura_kullaniliyor` · `409 karsilik_eksik` (`gonder: true` iken) |
| `GET /api/masraflar/:id` | | `MasrafDetay` (sahibi, onaycıları, muhasebe, yonetici) |
| `PATCH /api/masraflar/:id` | POST ile aynı alanlar, hepsi isteğe bağlı (`gonder` hariç) | `MasrafDetay` · `409 fatura_kullaniliyor` |
| `POST /api/masraflar/:id/gonder` | | `MasrafDetay` · `409 onaylayan_yok` · `409 karsilik_eksik` |
| `POST /api/masraflar/:id/geri-cek` | | `MasrafDetay` |
| `POST /api/masraflar/:id/iptal` | | `MasrafDetay` |
| `POST /api/masraflar/:id/onayla` | `{ aciklama? }` | `MasrafDetay` · `409 onay_beklemiyor` |
| `POST /api/masraflar/:id/reddet` | `{ aciklama }` (en az 3 karakter) | `MasrafDetay` |
| `POST /api/masraflar/:id/odendi` | | `MasrafDetay` |
| `POST /api/masraflar/:id/devret` | `{ onayId, yeniOnayciId }` | `MasrafDetay` |
| `GET /api/masraflar/disa-aktar?durum=&baslangic=&bitis=` | | `text/csv` (UTF-8 BOM, `;` ayraçlı; Excel uyumlu) |
| `GET /api/onaylar?durum=bekleyen\|karar` | | `MasrafOzet[]`: benim kararımı bekleyenler (eskiden yeniye) ya da karar verdiklerim (yeniden eskiye) |

Alan kuralları: `baslik` 1–120 karakter. `masrafTarihi` gelecekte olamaz. `tutar` 0'dan büyük, en çok 2 ondalık. `paraBirimi` ISO 4217 (varsayılan `PARA_BIRIMI`). `kur` para birimi farklıysa zorunlu. `faturaIdler` en çok 20 farklı fatura kimliğidir; her biri kullanıcının yüklediği bir fatura olmalı ve iptal edilmemiş başka bir formda kullanılmamalıdır. Yüklemediği fatura `400 gecersiz_istek` ve `alanlar["faturaIdler.<sıra>"]` döner; başka formdaki fatura `409 fatura_kullaniliyor` döner, hangi faturanın sorunlu olduğu yine `alanlar["faturaIdler.<sıra>"]` içindedir (sıra 0'dan başlar). İki istek aynı faturayı aynı anda alırsa ikincisi `alanlar` olmadan `409 fatura_kullaniliyor` alabilir. Fatura başka bir kullanıcının formundaysa mesaj o formun numarasını vermez. `yerelKarsiliklar` fatura kimliğinden yerel para birimindeki tutara bir eşlemedir (`{ "<faturaId>": 6500 }`, tutar 0'dan büyük, en çok 2 ondalık). Yalnızca formdaki faturalar için verilebilir (`400`, `alanlar["yerelKarsiliklar.<faturaId>"]`). Karşılığa ihtiyacı olmayan faturanın karşılığı saklanmaz. Gönderimde eksik karşılık `409 karsilik_eksik` döner; eksik her fatura `alanlar["yerelKarsiliklar.<faturaId>"]` içindedir. Durumu uygun olmayan işlem `409 gecersiz_durum` döner.

Doğrulama hatası: `400 gecersiz_istek`, `alanlar` her alanın Türkçe hata mesajını taşır.

Ayrıntılar:

- `POST /api/masraflar` ile `gonder: true` tek işlemdir. Gönderim başarısız olursa (ör. `409 onaylayan_yok`) form da oluşturulmaz; istemci aynı gövdeyi `gonder: false` ile taslak olarak kaydedebilir.
- `PATCH` içinde `kur`, `satici` ve `aciklama` alanlarına `null` (metinlerde boş metin de olur) gönderilirse alan temizlenir. Gönderilmeyen alan değişmez.
- `faturaIdler` gönderilirse formun fatura listesinin tamamı yerine geçer (sıra dahil). Fatura eklemek ya da çıkarmak için istemci güncel listenin tamamını gönderir; `[]` bütün faturaları kaldırır. Gönderilmezse faturalar değişmez. Listedeki değişiklik form geçmişine yazılır ("1 fatura eklendi, 1 fatura çıkarıldı.").
- `yerelKarsiliklar` gönderilirse bütün karşılıkların yerine geçer. Gönderilmezse formda kalan faturaların karşılıkları korunur. Formun para birimi değişip bir fatura artık karşılık gerektirmiyorsa karşılığı silinir.
- `tutarFarki.fatura` ve `tutarFarki.beyan` formun kendi para birimindedir (`paraBirimi`). `tutarFarki.fatura`, 6. kuraldaki gibi toplama giren faturaların toplamıdır; yerel para birimindeki tutarlar (yerel faturalar ve girilen karşılıklar) formun kuruyla formun para birimine çevrilir. Toplama giren en az bir fatura varsa ve iki tutar kuruşa yuvarlandığında farklıysa dolar. Karşılığı girilmemiş fatura toplama girmez.
- Temel para birimi (`PARA_BIRIMI`) `GET /api/ozet` ve `GET /api/onay-akislari` yanıtlarındaki `paraBirimi` alanından okunur.
- `null` olabilen alanlar: `Kullanici.departman`, `Kullanici.sonGiris`, `Kullanici.onayAkisiId`, `Akis.guncelleyen`, `MasrafOzet.satici`, `MasrafOzet.gonderim`, `MasrafOzet.siradakiOnayci`, `MasrafDetay.aciklama`, `kur`, `onayTutari`, `sonuclanma`, `odeme`, `faturalar` içindeki okunan alanlar (`faturaNo`, `faturaTarihi`, `saticiUnvan`, `genelToplam`, `paraBirimi`, `mime`) ve `yerelKarsilik`. `Kategori.simge` her zaman doludur (varsayılan `diger`). `faturaIdler` ve `faturalar` her zaman dizidir.
- Okuma kuyruğu sunucunun belleğindedir; sunucu yeniden başlarsa `GET /api/invoices/toplu/:id` `404` döner. Okunmuş faturalar kaybolmaz: `GET /api/invoices` kullanıcının yüklediklerini en yeniden listeler.
- `GET /api/onaylar` sayfalanmaz: `bekleyen` bekleyenlerin hepsini, `karar` son 200 kararı döner.
- Devretme: yalnızca karar verilmemiş adım (`bekliyor` ya da `sirada`) devredilir. Yeni onaycı aktif olmalı; formun sahibi, adımın şimdiki onaycısı ya da bu turda zaten bekleyen/sıradaki bir adımı olan kişi olamaz. Aykırı istekler `400 gecersiz_istek` ve `alanlar.onayId` ya da `alanlar.yeniOnayciId` ile döner. Devredilen eski onaycı form ve faturasını artık göremez (`404`).
- Para birimi değiştirilip yeni `kur` verilmezse eski kur taşınmaz: yeni para birimi temel para birimi değilse `400` ve `alanlar.kur` döner.
- `alanlar` anahtarları alan adlarıdır; dizi ve iç içe alanlarda yol olarak yazılır (`adimlar.0.limit`, `durum.0`). Belirli bir alana bağlanamayan hata (ör. bilinmeyen alan) `_` anahtarındadır. Devretme yalnızca yönetici işidir ve kullanıcı listesi gerektirdiği için panelden yapılır.

### Faturalar (mevcut uçlar, artık oturum ister)

| İstek | Değişiklik |
|---|---|
| `POST /api/invoices`, `POST /api/invoices/toplu` | Yükleyen kullanıcı kaydedilir, orijinal dosya veritabanında saklanır |
| `GET /api/invoices` | `calisan` yalnızca kendi yüklediklerini görür |
| `GET /api/invoices/:id` | Yükleyen, faturayı kullanan (ya da iptal edilmeden önce kullanmış) formun sahibi ve onaycıları, muhasebe, yonetici |
| `GET /api/invoices/:id/dosya` | **Yeni.** Orijinal dosya, doğru `Content-Type` ile. Dosyası olmayan eski kayıtlarda `404` |
| `GET /api/invoices/toplu/:id` | Yalnızca kuyruğu oluşturan kullanıcı (ve muhasebe/yonetici) |
| `GET /api/izleme`, `/api/izleme/akis` | `calisan` yalnızca kendi etkinliklerini görür; sayaçlar geneldir |

Mobil için önerilen okuma akışı: dosyayı `POST /api/invoices/toplu` ile gönder (`202`), `GET /api/invoices/toplu/:id` ile birkaç saniyede bir sor. Dosya `bitti` olunca `kayitId` ve `sonuc` gelir. Formu `sonuc.fatura` ile doldur (`genelToplam` → tutar, `paraBirimi`, `faturaTarihi` → masraf tarihi, `saticiUnvan` → satıcı), `faturaIdler: [kayitId]` ile kaydet. Birden çok fiş için her dosyanın `kayitId` değeri listeye eklenir ve tutar, aynı para birimindeki genel toplamların toplamıyla doldurulur. Formun ve yerel para biriminin dışındaki bir fişin yerel karşılığı kullanıcıdan istenir ve `yerelKarsiliklar` ile gönderilir. Okuma sırasında kullanıcı kategori ve açıklama girebilir.

## 7. Ayarlar (`.env`)

Bütün ayarlar kök dizindeki `.env` dosyasından okunur (`env.example` şablondur: `copy env.example .env`). Sunucu `node --env-file-if-exists=.env` ile başlar. `docker compose` de aynı dosyayı kullanır. Mobil uygulamanın ayarları `masraf-app/.env` içindedir (`EXPO_PUBLIC_*`).

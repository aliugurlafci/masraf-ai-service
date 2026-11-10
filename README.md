# Masraf

Şirket içi masraf yönetimi. Çalışan fişini ya da faturasını yükler, fatura kendi Claude aboneliğinizle okunur ve masraf formu dolar. Form, tutarına göre onay akışındaki onaycılara sırayla gider; onaylanan masraflar muhasebe tarafından ödendi olarak işaretlenir. Bütün veriler Docker'da çalışan SQL Server'da tutulur. Servis varsayılan olarak yalnızca sizin makinenizde (`127.0.0.1`) çalışır; telefondan kullanmak için aynı Wi-Fi'ye açılabilir (`AG_ERISIMI`).

- **Web paneli** (`http://127.0.0.1:4000`): masraflar, onay kutusu, fatura okuma ve canlı izleme; yöneticiler için kullanıcılar, onay akışı, tanım listeleri (organizasyon, masraf merkezi, kategori, etiket, proje kodu gibi; Excel ile içe/dışa aktarma), alan yönetimi ve denetim kaydı.
- **Mobil uygulama** (`masraf-app/`, React Native Expo): fişi fotoğraflayıp masraf oluşturma, onaylama. Kurulumu `masraf-app/README.md` dosyasındadır.
- **API**: panelin ve mobil uygulamanın kullandığı uçların hepsi. Onay sisteminin kuralları ve API sözleşmesi `docs/onay-sistemi.md` dosyasındadır.

## Onay sistemi kısaca

- Yönetici "Onay akışı" sayfasında birden çok adlandırılmış onay akışı tanımlayabilir: örneğin "Satış", "Yönetim". Biri varsayılandır. Her kullanıcı "Kullanıcılar" sayfasından bir akışa atanır; atanmamış kullanıcılar varsayılan akışı kullanır.
- Her akışta onaycılar sırayla tanımlanır ve her onaycının bir onay limiti vardır: son onayını verebileceği en yüksek tutar (dahil, kuruş hassasiyetinde). Limitler sırayla büyür, son onaycının limiti sınırsızdır; böylece her tutarı onaylayacak tam bir onaycı (karar veren onaycı) bulunur. Her akışta en az bir onaycı olmak zorundadır; kurala uymayan akış kaydedilmez. Aynı kişi farklı akışlarda farklı limitlerle yer alabilir.
- Akışın stratejisi masrafı kimin göreceğini belirler. **Zincirleme onayda** (`zincir`) masraf ilk onaycıdan başlar ve karar veren onaycıya kadar sıradaki herkesin onayından geçer; tutar büyüdükçe zincir uzar. **Tek onaycıda** (`tek`) masrafı yalnızca karar veren onaycı onaylar. Örneğin limitler 5.000, 50.000 ve sınırsızsa 20.000'lik masraf zincirleme onayda 1. ve 2. onaycıya sırayla, tek onaycıda yalnızca 2. onaycıya gider.
- Bir masrafa birden çok fatura eklenebilir (en çok 20; örneğin bir seyahatin otel, taksi ve yemek fişleri). Bir fatura iptal edilmemiş yalnızca bir masrafta kullanılabilir.
- Sunucu yoğunken fişin sırası ve önünde kaç fatura olduğu gösterilir. Masraf, fişlerin okunmasını beklemeden taslak olarak kaydedilebilir (tutar boş bırakılabilir). Fişler arka planda okunur ve forma eklenir; boş tutar ve satıcı faturalardan doldurulur, sahibine bildirim (ve açıksa mail) gider. Kaydederken "okumalar bitince onaya gönder" seçilirse form kendiliğinden onaya çıkar; gönderilemezse sebebiyle birlikte bildirilir.
- Yönlendirmede kullanılan tutar, beyan edilen tutar ile bağlı faturaların toplamından büyük olanıdır (yabancı para biriminde kurla çevrilir). Formun ve TRY'nin dışında bir para birimindeki faturanın TRY karşılığını çalışan girer; karşılığı girilmemiş faturayla form onaya gönderilemez.
- Gönderenin kendisi onaycıysa kendi adımı atlanır. Karar veren onaycı kendisiyse son onay bir üst onaycıya geçer; akışın en üstündeyse bir yöneticiye gider.
- Reddedilen form sahibine döner; düzeltilip yeniden gönderilebilir. Yönetici bekleyen bir onayı başka bir kullanıcıya devredebilir.
- Yönetici kullanıcıya bir organizasyon ve bir ya da birden çok masraf merkezi tanımlar; çalışan formda bunlardan birini seçer. Etiket, proje kodu, ödeme yöntemi, doküman tipi, not gibi alanlar her fiş için ayrı doldurulur, fiş okunurken de düzenlenebilir.
- "Alan yönetimi" sayfasında fiş alanı eklenir, çıkarılır (pasifleştirilir), hangi fatura bilgilerinin ve fiş alanlarının zorunlu olduğu seçilir. Koşullu kurallarla bir değere bağlı zorunluluk tanımlanır: örneğin "Kategori ARAÇ BAKIM ONARIM ise Etiket zorunlu". Eksik alanlı form taslak kaydedilir ama onaya gönderilemez.
- Organizasyonlar, masraf merkezleri, kategoriler ve liste alanlarının seçenekleri panelden yönetilir; Excel (`.xlsx`, en çok 5 MB ve 20.000 satır) ile önce önizlenip içe aktarılır, dışa aktarılır. masraff.io dışa aktarımlarının sütun adları tanınır.

Roller: `calisan` (kendi masrafları ve onaycısı olduğu formlar), `muhasebe` (bütün masrafları görür, ödendi işaretler, dışa aktarır), `yonetici` (her şey; kullanıcılar, onay akışları, tanım listeleri, alan yönetimi). Onaycı olmak bir rol değildir: bir akışa eklenen herkes onaycıdır.

## Gereksinimler

- Node.js 24.18 veya üstü
- Docker Desktop (SQL Server 2022 konteyneri için)
- Claude Code CLI (`claude --version` çalışmalı)
- Claude Pro veya Max aboneliği (API anahtarı gerekmez)

## Kurulum

1. Ayar dosyasını oluşturun:

   ```
   copy env.example .env
   ```

   `.env` içinde en az şunları doldurun:

   - `MSSQL_PASSWORD`: SQL Server `sa` şifresi. En az 8 karakter; büyük harf, küçük harf, rakam ve sembolden en az üçü.
   - `ILK_YONETICI_EPOSTA`, `ILK_YONETICI_SIFRE`: ilk açılışta oluşturulacak yönetici. Şifre en az 8 karakter, en az bir harf ve bir rakam.

2. Veritabanını başlatın:

   ```
   npm run db:up
   ```

   SQL Server konteyneri `127.0.0.1:1433` üzerinde açılır, veriler `mssql-data` Docker biriminde kalır. Sunucu ilk açılışta `MSSQL_DATABASE` veritabanını ve tabloları kendisi oluşturur. Durdurmak için `npm run db:down` (veriler silinmez).

3. Abonelik token'ı alın:

   ```
   claude setup-token
   ```

   Çıkan `sk-ant-oat01-…` değerini `secrets/claude_oauth_token.txt` dosyasına tek satır olarak kaydedin. Bu dosya git'e girmez. Token'ı kimseyle paylaşmayın.

4. Bağımlılıkları kurun ve servisi başlatın:

   ```
   npm install
   npm start
   ```

   İlk açılışta konsolda "İlk yönetici oluşturuldu" yazar. Bundan sonra `.env` içindeki `ILK_YONETICI_SIFRE` değerini silebilirsiniz.

5. Tarayıcıda `http://127.0.0.1:4000` adresini açın ve ilk yöneticiyle giriş yapın. "Onay akışı" sayfasından onaycıları, onay limitlerini ve akışın stratejisini (zincirleme onay ya da tek onaycı) tanımlayın (gerekirse ekip başına ayrı akışlar ekleyin), "Kullanıcılar" sayfasından çalışanları ekleyip akışlarına atayın. Yeni kullanıcılar ilk girişte şifrelerini değiştirir.

## API

`/health` ve `POST /api/oturum` dışındaki bütün uçlar oturum ister. Panel çerezle çalışır; API istemcileri ve mobil uygulama token alır:

```
curl.exe -H "Content-Type: application/json" -d "{\"eposta\":\"ali@firma.com\",\"sifre\":\"…\",\"istemci\":\"api\"}" http://127.0.0.1:4000/api/oturum
```

Yanıttaki `token` değerini sonraki isteklerde `Authorization: Bearer <token>` başlığıyla gönderin. Oturum `OTURUM_SURESI_SAAT` kadar geçerlidir ve kullanıldıkça uzar. Aşağıdaki örneklerde PowerShell'de önce `$t = "<token>"` yazdığınız varsayılır.

Masraf, onay, kullanıcı, onay akışı, tanım listesi (Excel içe/dışa aktarma dahil) ve fiş alanı uçlarının tamamı `docs/onay-sistemi.md` dosyasının 6. bölümündedir. Bu bölüm fatura okuma uçlarını anlatır.

Bir fatura okumak bir dakika kadar sürebilir. Aynı anda en fazla 2 fatura okunur (`CLAUDE_MAX_CONCURRENT`); diğerleri sırada bekler. Bu sınır tekli ve çoklu gönderimler için ortaktır.

Postman kullanıyorsanız kök dizindeki `fatura-okuyucu.postman_collection.json` dosyasını içe aktarın (Import). Koleksiyonun `eposta` ve `sifre` değişkenlerini doldurup önce "Giriş yap" isteğini çalıştırın; token koleksiyona kaydedilir ve diğer istekler onu kullanır. "Fatura oku" isteklerinde dosyayı Postman'da seçmeniz yeterli.

### Fatura gönderme

Multipart form ile, dosya `file` alanında:

```
curl.exe -H "Authorization: Bearer $t" -F "file=@fatura.pdf" http://127.0.0.1:4000/api/invoices
```

Ya da dosyanın kendisi istek gövdesinde:

```
curl.exe -H "Authorization: Bearer $t" --data-binary "@fatura.pdf" -H "Content-Type: application/pdf" -H "X-File-Name: fatura.pdf" http://127.0.0.1:4000/api/invoices
```

- Windows PowerShell'de `curl` başka bir komutun takma adıdır; `curl.exe` yazın.
- `X-File-Name` başlığı isteğe bağlıdır. Türkçe karakter içeriyorsa URL kodlamasıyla gönderin (`encodeURIComponent`).
- Kabul edilen türler PDF, PNG, JPEG, WEBP ve GIF'tir. Tür, dosya adına göre değil dosyanın içeriğine göre belirlenir.
- Dosya en fazla 20 MB olabilir.

Başarılı yanıtın durumu `201`'dir:

- `X-Fatura-Id` başlığı kayıt kimliğini taşır.
- `Location` başlığı kaydın adresini verir.

Aynı dosya (içeriği birebir aynı) ikinci kez gönderilirse Claude çalıştırılmaz, kayıtlı sonuç hemen döner:

- Durum `200` olur ve `X-Fatura-Onbellek: 1` başlığı eklenir.
- Aynı dosya o anda okunuyorsa ikinci istek yeni bir okuma başlatmaz, süren okumanın sonucunu bekler. Zaman aşımına uğrayıp tekrar deneyen istemciler böylece aboneliği iki kez harcamaz.
- Yine de yeniden okutmak için adrese `?yenile=1` ekleyin: `http://127.0.0.1:4000/api/invoices?yenile=1`.

```json
{
  "fatura": {
    "faturaNo": "ABC2026000000123",
    "faturaTarihi": "2026-11-05",
    "saticiUnvan": "Örnek Yazılım A.Ş.",
    "saticiVergiNo": "1234567890",
    "aliciUnvan": "Deneme Ltd. Şti.",
    "aliciVergiNo": "9876543210",
    "paraBirimi": "TRY",
    "araToplam": 1500,
    "kdvToplam": 300,
    "genelToplam": 1800
  },
  "kalemler": [
    { "aciklama": "Danışmanlık", "miktar": 2, "birim": "saat", "birimFiyat": 500, "kdvOrani": 20, "tutar": 1000 }
  ],
  "olcum": {
    "kaynak": "claude",
    "istekSuresiMs": 14350,
    "okuma": {
      "sureMs": 14200,
      "apiSureMs": 12800,
      "tur": 2,
      "girdiToken": 12,
      "onbellektenToken": 15800,
      "onbellegeToken": 0,
      "ciktiToken": 420,
      "apiEsdegeriUsd": 0.0312,
      "model": "claude-sonnet-5-5",
      "effort": "low"
    }
  }
}
```

Fatura verisi `fatura` ve `kalemler` alanlarındadır. `olcum` alanı okumanın ölçümüdür; istemciniz ihtiyaç duymuyorsa yok sayabilir.

| `olcum` alanı | Anlamı |
|---|---|
| `kaynak` | `claude`: bu istekte Claude çalıştı. `kayit`: kayıtlı sonuç döndü |
| `istekSuresiMs` | Bu isteğin sunucudaki süresi |
| `okuma` | Faturayı üreten Claude okumasının ölçümü. Kayıttan dönen yanıtlarda da ilk okumanın değerleri gelir. Ölçüm eklenmeden önce kaydedilmiş faturalarda `null` olur |
| `okuma.sureMs` / `okuma.apiSureMs` | Okumanın toplam süresi ve bunun modelde geçen kısmı. Aradaki fark CLI'nin açılış süresidir |
| `okuma.tur` | Claude'un kaç adımda bitirdiği (dosyayı okuma ve cevap) |
| `okuma.girdiToken`, `onbellektenToken`, `onbellegeToken`, `ciktiToken` | Token kullanımı. Toplam girdi, ilk üçünün toplamıdır. `onbellektenToken` önceki okumalardan yeniden kullanılan talimatlardır |
| `okuma.apiEsdegeriUsd` | Aynı okuma ücretli API ile yapılsaydı tutacak ücret. Aboneliğe ek ücret yansımaz |
| `okuma.model` / `okuma.effort` | Sonucu veren model ve düşünme düzeyi (`null`: CLI varsayılanı) |
| `okuma.adimlar` | Dosyayı okuyan her model, sırayla (aşağıda "Kademeli okuma"). Her adımda süre ve token değerleri, `sorunlar` (kontrollerin bulduğu sorunlar), `hata` (model okuyamadıysa nedeni) ve `kullanildi` (sonucun bu okumadan alınıp alınmadığı) bulunur. Üstteki süre, token ve ücret değerleri adımların toplamıdır |

Panelde aynı değerler faturanın altındaki "Ölçüm" bölümünde görünür.

Alanların biçimi:

- Faturada bulunmayan alanlar `null` olur.
- Tarihler `YYYY-MM-DD` biçimindedir.
- Tutarlar ve miktarlar sayıdır.
- `kdvOrani` yüzde değeridir; %20 için `20` yazılır.
- `paraBirimi` ISO 4217 kodudur (`TRY`, `USD`, `EUR`).

### Çoklu gönderme (kuyruk)

Birden fazla dosyayı tek istekte multipart form ile gönderin. Alan adı önemli değildir; formdaki her dosya alınır:

```
curl.exe -H "Authorization: Bearer $t" -F "files=@ekim.pdf" -F "files=@kasim.pdf" -F "files=@fis.jpg" http://127.0.0.1:4000/api/invoices/toplu
```

Sunucu Claude okumasını beklemeden yanıt verir. `Location` başlığı kuyruğun adresidir.

- Daha önce okunmuş dosyalar yanıtta hemen `bitti` olarak, faturalarıyla (`sonuc`) birlikte gelir.
- Dosyaların hepsi daha önce okunmuşsa (ya da reddedildiyse) durum `200`, `bitti: true` olur; başka istek gerekmez.
- Claude'un okuması gereken dosya varsa durum `202` olur; bu dosyalar `sirada` ya da `okunuyor` görünür.

```json
{
  "id": "20261106-110215-8c1f02ab",
  "olusturulma": "2026-11-06T11:02:15.120Z",
  "bitti": false,
  "esZamanli": 2,
  "sayac": { "toplam": 3, "sirada": 1, "okunuyor": 1, "bitti": 1, "hata": 0 },
  "dosyalar": [
    { "sira": 1, "dosyaAdi": "ekim.pdf", "dosyaOzeti": "0b87b8…", "durum": "bitti", "kuyrukSirasi": null, "onundeki": null,
      "kayitId": "20261105-163012-0b9c44d1", "onbellek": true, "hata": null,
      "sonuc": { "fatura": { "faturaNo": "ABC2026000000123", "…": "…" }, "kalemler": [ { "aciklama": "Danışmanlık", "…": "…" } ] } },
    { "sira": 2, "dosyaAdi": "kasim.pdf", "dosyaOzeti": "5e1f02…", "durum": "okunuyor", "kuyrukSirasi": null, "onundeki": null,
      "kayitId": null, "onbellek": false, "hata": null, "sonuc": null },
    { "sira": 3, "dosyaAdi": "fis.jpg", "dosyaOzeti": "a91c3d…", "durum": "sirada", "kuyrukSirasi": 3, "onundeki": 4,
      "kayitId": null, "onbellek": false, "hata": null, "sonuc": null }
  ]
}
```

İlerlemeyi `GET /api/invoices/toplu/<id>` ile izleyin. Aynı biçimde döner; birkaç saniyede bir sormak yeterlidir. Kuyruğu yalnızca oluşturan kullanıcı (ve muhasebe/yönetici) görebilir.

- `durum`: `sirada` → `okunuyor` → `bitti` ya da `hata`. Dosyalar gönderildikleri sırayla okunur, aynı anda en fazla `esZamanli` tanesi.
- `kuyrukSirasi` ve `onundeki`: `sirada` olan dosyanın, bütün kullanıcıların dosyalarıyla ortak sıradaki yeri (1 = sıradaki) ve ondan önce okunacak ya da okunmakta olan dosya sayısı. Örnekte "Sırada 3. · önünde 4 fatura var". Yeri henüz belli değilse ya da dosya sırada değilse `null`.
- `dosyaOzeti`: dosyanın SHA-256'sı. Okuması bitmeden kaydedilen masraf formu bu dosyayı `bekleyenFaturalar` içinde bu değerle anar (`docs/onay-sistemi.md`, bölüm 3 ve 6). Reddedilen dosyada `null`.
- `bitti: true` olduğunda bütün dosyalar okunmuş ya da hata almıştır.
- `sonuc`: okunan dosyanın faturası (`fatura` ve `kalemler`). Ölçüm (`olcum`) dahil tam kayıt `GET /api/invoices/<kayitId>` ile alınır.
- `onbellek: true`: dosya daha önce okunmuş, kayıtlı sonuç kullanıldı; Claude çalışmadı. Aynı dosya bir istekte iki kez varsa bir kez okunur, ikincisi `onbellek: true` olur. Yine de yeniden okutmak için `?yenile=1` ekleyin.
- `hata`: `{kod, mesaj}`. Kodlar aşağıdaki hata tablosundakilerle aynıdır. Hatalı ya da büyük bir dosya yalnızca kendisini etkiler, diğerleri okunur.
- Bir istekte en fazla 50 dosya ve toplam 200 MB gönderilebilir. Daha fazlası için birkaç istek gönderin.
- Kuyruk sunucunun belleğinde tutulur. Sunucu yeniden başlarsa kuyruk adresi `404` döner; o ana kadar okunan faturalar kayıtlarda durur, okunmamış dosyaları yeniden gönderin.
- `claude_limit` (abonelik limiti) hatası alan dosyalar kendiliğinden yeniden denenmez. Limit açılınca yeniden gönderin; okunmuş olanlar kayıttan döner.

### Canlı izleme

Sunucu açıldığından beri gelen her dosya, tekli ya da çoklu, panelden ya da API'den, bir "etkinlik" olarak izlenir. Panelin sol sütunu bunu gösterir: okuma hatları (şu an Claude'un okuduğu dosyalar ve modeli), sıradaki dosyalar ve akış. Aynı bilgiye API'den de ulaşılır:

| İstek | Döndürdüğü |
|---|---|
| `GET /api/izleme` | Anlık durum: `istatistik` ve en yeni başta `etkinlikler` |
| `GET /api/izleme/akis` | Server-Sent Events akışı: önce `durum` (anlık durumun tamamı), sonra her değişiklikte `etkinlik` |

```json
{
  "istatistik": { "baslangic": "2026-11-06T09:00:00.000Z", "esZamanli": 2, "sirada": 1, "okunuyor": 2, "bitti": 14, "kayittan": 5, "hata": 1, "apiEsdegeriUsd": 0.4123 },
  "etkinlikler": [
    { "id": "3f9c1a7be210", "dosyaAdi": "kasim.pdf", "boyut": 48211, "kaynak": "api", "etiket": null,
      "kuyrukId": "20261106-110215-8c1f02ab", "sira": 2, "durum": "okunuyor", "model": "opus", "modeller": ["haiku", "opus"],
      "onbellek": false, "kayitId": null, "hata": null, "ozet": null, "apiEsdegeriUsd": null,
      "alinma": "2026-11-06T11:02:15.120Z", "baslama": "2026-11-06T11:02:16.004Z", "bitis": null }
  ]
}
```

- `durum`: `sirada` → `okunuyor` → `bitti` ya da `hata`. Reddedilen dosyalar (desteklenmeyen tür, büyük dosya) doğrudan `hata` olarak görünür.
- `model`: okuyan model; kademeli okumada önce `haiku`, kontroller tutmazsa `opus`. Bittiğinde sonucu kullanılan modelin tam adı yazar. `modeller` bu dosyayı okuyan bütün modellerdir.
- `ozet`: bitmiş okumanın fatura no, tarih, satıcı, genel toplam, para birimi ve kalem sayısı. Faturanın tamamı `GET /api/invoices/<kayitId>` ile alınır.
- `kaynak`: `panel`, `api` ya da `arka_plan`. Panel isteklerine `X-Panel-Etiket` başlığı ekler; bu başlığı taşımayan her istek `api` sayılır. `arka_plan`, okunması bitmeden kaydedilmiş bir formun dosyasını sunucunun kendisinin okumasıdır (örneğin yeniden başlatmadan sonra ya da "Yeniden oku" ile).
- `kuyrukSirasi`, `onundeki`: sıradaki dosyanın yeri, toplu yüklemedeki gibi.
- `kullanici`: dosyayı gönderen (`{id, adSoyad}`). Çalışanlar yalnızca kendi etkinliklerini görür; muhasebe ve yönetici hepsini. `istatistik` sayaçları geneldir.
- `istatistik` sayaçları sunucunun açılışından (`baslangic`) beri sayar. `apiEsdegeriUsd` Claude'un gerçekten çalıştığı okumaların API karşılığıdır; aboneliğe ek ücret yansımaz.
- Etkinlikler bellekte tutulur: süren okumaların hepsi ve bitenlerin son 300'ü. Sunucu yeniden başlayınca sıfırlanır, okunan faturalar veritabanında kalır.
- Akış her 20 saniyede bir `: canli` yorum satırı gönderir. Bağlantı koparsa tarayıcı 3 saniye sonra yeniden bağlanır ve yeni bir `durum` alır.

PowerShell'de akışı izlemek için: `curl.exe -N -H "Authorization: Bearer $t" http://127.0.0.1:4000/api/izleme/akis`

### Kayıtlar

Okunan her fatura, orijinal dosyasıyla birlikte veritabanına (`fatura_kayitlari`, `fatura_dosyalari`) kaydedilir. Aynı dosyayı kimin yüklediği de tutulur.

| İstek | Döndürdüğü |
|---|---|
| `GET /api/invoices` | Son 100 kaydın özeti, en yeni başta. Çalışan yalnızca kendi yüklediklerini görür |
| `GET /api/invoices/<id>` | Kayıtlı sonucun kendisi (yukarıdaki JSON; `olcum.kaynak` her zaman `kayit`). Yükleyen, faturayı kullanan formun sahibi ve onaycıları, muhasebe ve yönetici açabilir |
| `GET /api/invoices/<id>/dosya` | Orijinal dosya (PDF ya da resim), doğru `Content-Type` ile |
| `GET /health` | `{"durum":"ok"}` (oturum istemez) |

### Hatalar

Hatalı isteklerde gövde `{"hata": {"kod": "...", "mesaj": "..."}}` biçimindedir. `mesaj` her zaman Türkçedir ve kullanıcıya gösterilebilir. Doğrulama hatalarında `alanlar` (alan başına mesaj), onay akışı hatalarında `sorunlar` (liste) de gelir.

| HTTP | kod | Anlamı |
|---|---|---|
| 400 | `dosya_yok`, `gecersiz_form` | Dosya gönderilmedi veya form bozuk (çoklu gönderme yalnızca multipart kabul eder) |
| 400 | `cok_fazla_dosya` | Çoklu gönderimde 50'den fazla dosya |
| 400 | `gecersiz_istek`, `gecersiz_json` | Alanlar kurallara uymuyor ya da gövde JSON değil |
| 400 | `gecersiz_akis` | Onay akışı boş, bir kullanıcı iki kez yer alıyor, limitler sırayla büyümüyor ya da son onaycının limiti sınırsız değil |
| 401 | `oturum_gerekli`, `hatali_giris` | Oturum yok/süresi dolmuş ya da e-posta veya şifre yanlış |
| 403 | `yetki_yok`, `hesap_pasif`, `sifre_degismeli` | Rol yetmiyor, hesap pasif ya da önce şifre değiştirilmeli |
| 403 | `izinsiz_host`, `izinsiz_kaynak`, `izinsiz_ag` | İstek izinli adresler (127.0.0.1, localhost; yerel ağ erişimi açıksa bilgisayarın yerel ağ adresi) dışından, başka bir web sitesinden ya da yerel ağ dışından geldi |
| 404 | `bulunamadi` | Kayıt, form, kullanıcı ya da kuyruk yok (ya da görme yetkiniz yok) |
| 409 | `okuma_suruyor`, `okuma_hatali`, `tutar_eksik` | Masraf onaya gönderilemiyor: faturası hâlâ okunuyor, okunamayan faturası var ya da tutarı boş |
| 409 | `gecersiz_durum`, `onay_beklemiyor`, `onaylayan_yok`, `fatura_kullaniliyor`, `eposta_kullaniliyor`, `son_yonetici`, `onay_akisinda`, `bekleyen_onay_var`, `akis_adi_kullaniliyor`, `varsayilan_akis` | İşlem formun, kullanıcının ya da onay akışının şu anki durumuna uymuyor; ayrıntısı `mesaj` alanında |
| 413 | `dosya_cok_buyuk` | Dosya boyut sınırını aşıyor |
| 413 | `istek_cok_buyuk` | Çoklu gönderimde dosyaların toplamı 200 MB'ı aşıyor |
| 415 | `desteklenmeyen_dosya` | PDF veya resim değil |
| 422 | `invalid_output` | Claude'un yanıtı fatura şemasına uymadı |
| 429 | `claude_limit` | Abonelik kullanım limiti doldu; bir süre sonra tekrar deneyin |
| 429 | `cok_fazla_deneme` | Arka arkaya hatalı giriş; e-posta `GIRIS_KILIT_DAKIKA` süresince kilitli |
| 502 | `claude_failed` | Claude çalıştırılamadı veya hata döndürdü |
| 503 | `claude_auth` | Token geçersiz ya da süresi dolmuş; `claude setup-token` ile yenileyin |
| 504 | `claude_timeout` | Claude zamanında yanıt vermedi |

## Ayarlar

Bütün ayarlar kök dizindeki `.env` dosyasındadır (şablon: `env.example`). `npm start`, `npm run dev` ve `npm run karsilastir` bu dosyayı kendiliğinden okur; `docker compose` (`npm run db:up`) da aynı dosyayı kullanır. Ortamda zaten tanımlı bir değişken `.env` içindekinden önce gelir. Değişiklikten sonra sunucuyu yeniden başlatın.

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `PORT` | `4000` | Dinlenen port |
| `AG_ERISIMI` | `kapali` | `kapali`: yalnızca bu bilgisayar (127.0.0.1). `yerel`: aynı Wi-Fi'deki telefonlar da bağlanır; ayrıntı ve riskler "Güvenlik" bölümünde |
| `IZINLI_HOSTLAR` | (yok) | Yerel ağ erişiminde, bilgisayarın IP adreslerine ek olarak kabul edilen adlar, virgülle (örn. `masraf-pc.local`) |
| `MAX_FILE_MB` | `20` | En büyük fatura dosyası (1–32) |
| `MSSQL_PASSWORD` | (zorunlu) | SQL Server `sa` şifresi. Docker bunu yalnızca veritabanı birimi ilk oluşturulurken kullanır |
| `MSSQL_HOST`, `MSSQL_PORT` | `127.0.0.1`, `1433` | SQL Server adresi. Docker portu yalnızca 127.0.0.1'e açar |
| `MSSQL_DATABASE` | `masraf` | Veritabanı adı; yoksa açılışta oluşturulur, tablolar kurulur |
| `MSSQL_USER` | `sa` | Bağlanan kullanıcı |
| `MSSQL_ENCRYPT`, `MSSQL_TRUST_SERVER_CERTIFICATE` | `true`, `true` | TLS ve yerel konteynerin kendi imzalı sertifikasına güven |
| `MSSQL_POOL_MAX` | `10` | Bağlantı havuzu boyutu (1–100) |
| `MSSQL_CONNECT_WAIT_SEC` | `60` | Açılışta veritabanını bekleme süresi (0–600) |
| `MSSQL_IMAGE`, `MSSQL_PID` | `…/mssql/server:2022-latest`, `Developer` | Docker imajı ve SQL Server sürümü (yalnızca `docker compose`) |
| `ILK_YONETICI_EPOSTA`, `ILK_YONETICI_SIFRE`, `ILK_YONETICI_AD` | (yok) | Veritabanında hiç kullanıcı yokken oluşturulan yönetici; varsayılan akışın ilk onaycısı olur (limiti sınırsız) |
| `OTURUM_SURESI_SAAT` | `168` | Oturum süresi; kullanıldıkça uzar (1–8760) |
| `GIRIS_DENEME_SINIRI`, `GIRIS_KILIT_DAKIKA` | `10`, `15` | Bu kadar hatalı girişte e-posta bu kadar dakika kilitlenir |
| `SIFRE_MIN_UZUNLUK` | `8` | En kısa şifre (8–128) |
| `PARA_BIRIMI` | `TRY` | Onay limitlerinin ve raporların para birimi; başka para birimindeki masraflarda kur girilir |
| `MAIL_GONDERIM` | `kapali` | `kapali`: bildirim mailleri gönderilmez, giden kutusuna `atlandi` olarak yazılır (uygulama içi bildirimler yine oluşur). `smtp`: aşağıdaki sunucuyla gönderilir |
| `SMTP_HOST`, `SMTP_PORT` | (yok), `587` | SMTP sunucusu. `MAIL_GONDERIM=smtp` iken `SMTP_HOST` zorunlu |
| `SMTP_GUVENLIK` | `starttls` | `starttls` (genelde 587), `tls` (genelde 465) ya da `yok` (yalnızca güvenilir iç ağ) |
| `SMTP_KULLANICI`, `SMTP_SIFRE` | (yok) | SMTP kimliği; sunucu istemiyorsa boş. Şifre hiçbir kayda ve hata mesajına yazılmaz |
| `MAIL_GONDEREN` | (yok) | Gönderen adres, örn. `Masraf <masraf@firma.com>`. `MAIL_GONDERIM=smtp` iken zorunlu |
| `MAIL_DENEME_SAYISI` | `5` | Gönderilemeyen mailin en çok deneme sayısı (1–20); aralıklar 1, 5, 15, 60 dakika, sonra 60 dakika. Sonra mail `hata` olur |
| `UYGULAMA_ADRESI` | (yok) | Maillerdeki bağlantıların açacağı panel adresi (`http://` ya da `https://`). Boşsa bağlantı konmaz |
| `HATIRLATMA_BEKLEME_SAAT` | `24` | Bu kadar saatten uzun karar bekleyen onaycıya günde bir kez hatırlatma gider (0 = kapalı, en çok 720) |
| `HATIRLATMA_SAATI` | `09:00` | Hatırlatmaların gönderileceği saat (`SS:DD`, sunucunun yerel saati) |
| `CLAUDE_BIN` | `claude` | Claude Code CLI'nin yolu |
| `CLAUDE_MODEL` | `haiku,opus` | Modeller, en ucuzdan başlayarak virgülle (en çok 4). Sonraki model yalnızca önceki okuma kontrollerden geçmezse çalışır (aşağıda "Kademeli okuma"). Tek model için örneğin `opus` |
| `CLAUDE_EFFORT` | `low` | Claude'un düşünme düzeyi (`low`, `medium`, `high`, `xhigh`, `max`). `default` CLI'nin kendi ayarını kullanır. Karmaşık faturalarda yanlış okuma görürseniz `medium` deneyin |
| `CLAUDE_TIMEOUT_SEC` | `180` | Bir fatura için en uzun bekleme (10–900) |
| `CLAUDE_MAX_CONCURRENT` | `2` | Aynı anda okunan fatura sayısı (1–4). Kuyruktaki dosyalar bu sınırla okunur. Yükseltmek kuyruğu hızlandırır ama abonelik limiti daha çabuk dolar; `claude_limit` hatası görürseniz düşürün |
| `CLAUDE_OAUTH_TOKEN_FILE` | `secrets/claude_oauth_token.txt` | Token dosyası |
| `CLAUDE_CODE_OAUTH_TOKEN` | (yok) | Token'ı dosya yerine doğrudan verir |

## Güvenlik

- Servis varsayılan olarak yalnızca `127.0.0.1` adresinde dinler. Başka bir `Host` başlığıyla ya da başka bir siteden (Origin) gelen istekleri reddeder. Böylece tarayıcıda açtığınız bir web sayfası servise fatura gönderemez. Android emülatörü ya da USB ile bağlı Android cihaz `adb reverse tcp:4000 tcp:4000` ile, iOS simülatörü doğrudan `127.0.0.1` ile bağlanır.
- `AG_ERISIMI=yerel` ile servis aynı Wi-Fi'deki telefonlara açılır (iPhone ya da Wi-Fi'deki Android için tek yol; kurulumu `masraf-app/README.md` içinde). O zaman bütün IPv4 arabirimlerinde dinler, ama yalnızca özel ağ adreslerinden (192.168.x.x, 10.x.x.x, 172.16–31.x.x) ve bilgisayarın kendisinden gelen istekleri kabul eder; `Host` başlığı bilgisayarın kendi yerel ağ adresi, `localhost`, `127.0.0.1` ya da `IZINLI_HOSTLAR` içindeki bir ad olmalıdır. Bağlantı şifresiz HTTP'dir: aynı ağdaki biri oturum token'larını ve faturaları görebilir. Yalnızca güvendiğiniz ağlarda açın, misafir ve halka açık Wi-Fi'de kapalı tutun. Açıkken sunucu her açılışta uyarı yazar.
- Şifreler scrypt ile tuzlanarak saklanır. Oturum token'larının yalnızca SHA-256 özeti veritabanında durur. Panel oturumu `HttpOnly; SameSite=Strict` çerezdedir, JavaScript okuyamaz.
- Her yetki kontrolü sunucuda yapılır: çalışan başkasının masrafını ya da faturasını göremez, yalnızca sırası gelen onaycı karar verebilir. Kullanıcı, rol, onay akışı, tanım listesi, alan ve kural değişiklikleri ile Excel içe aktarmaları denetim kaydına yazılır.
- Excel dosyaları ek paket kullanmadan, yerleşik `zlib` ile okunur. Bozuk, şifreli ya da ZIP64 dosyalar reddedilir. Açılınca aşırı büyüyen dosyalara (zip bombası) karşı parça sayısı ve açılmış boyut sınırlıdır. Dışa aktarılan hücreler formül değil, düz metindir.
- SQL Server portu Docker'da yalnızca `127.0.0.1`'e açılır. Bütün sorgular parametrelidir.
- Claude her fatura için yeni ve boş bir geçici klasörde çalışır. O klasörde yalnızca fatura dosyası bulunur; iş bitince klasör silinir.
- Claude'un kullanabileceği tek araç `Read`'dir. Komut çalıştıramaz, dosya yazamaz, internette gezinemez.
- Kendi `~/.claude` ayarlarınız, hook'larınız, eklentileriniz, MCP sunucularınız ve CLAUDE.md dosyalarınız bu çağrıda yüklenmez.
- Ortam değişkenlerinden yalnızca gerekli olanlar (PATH, TEMP, proxy gibi) Claude'a aktarılır. `ANTHROPIC_API_KEY` ve diğer anahtarlar aktarılmaz.
- Token Claude'a ortam değişkeniyle verilir ve hata mesajlarında `[gizli]` olarak maskelenir.
- Kalan risk: token, Claude sürecinin ortamında bulunur. Komut çalıştıran araçlar kapalı olduğu için Claude onu başka bir yere taşıyamaz, ama token bu makinede düz metin olarak durur. Dosyayı paylaşmayın.

## Hız ve kullanım

Her okumanın ölçümü üç yerde görünür: paneldeki "Ölçüm" bölümünde, API yanıtının `olcum` alanında (alanlar yukarıdaki tabloda) ve sunucu konsolunda:

```
fatura okundu id=20261106-090807-3fa94c1d kalem=1 model=claude-sonnet-5-5 effort=low tur=2 sure=14200ms api=12800ms girdi=12 onbellekten=15800 onbellege=0 cikti=420
```

- `tur`: Claude'un kaç adımda bitirdiği (dosyayı okuma ve cevap).
- `sure` / `api`: Toplam süre ve bunun model tarafında geçen kısmı.
- `onbellekten`: Önceki okumalardan yeniden kullanılan talimat token'ları. Arka arkaya okunan faturalarda bu sayının büyük olması beklenir; okuma hızlanır ve abonelik limitinden daha az düşer.
- Dosya daha önce okunmuşsa Claude çalışmaz; konsola `fatura kayıttan döndü id=…` yazılır ve yanıtta `olcum.kaynak` `kayit` olur.

### Kademeli okuma

Varsayılan ayar `CLAUDE_MODEL=haiku,opus`:

1. Fatura önce en ucuz model olan Haiku ile okunur.
2. Sonuç sunucuda kontrol edilir. Bu kontrol token harcamaz.
3. Kontrol tutarsa Haiku'nun sonucu döner. Tutmazsa fatura Opus ile yeniden okunur ve Opus'un sonucu döner.

Kontroller:

- Fatura no, tarih, satıcı ve genel toplam okunmuş mu, en az bir kalem var mı.
- Her kalemde miktar × birim fiyat tutarı veriyor mu (KDV dahil tutar da kabul edilir).
- Kalemlerin toplamı ara toplamı, ara toplam ile KDV genel toplamı tutuyor mu.

Bu kontroller yanlış okunan rakamları (57,400 yerine 57,409, 4.032,36 yerine 4032360) ve boş okumaları yakalar. Yanlış okunan metni (firma adında bir harf, fatura numarasında `B` yerine `R`) yakalayamaz.

İskontolu, tevkifatlı ya da fatura olmayan belgeler kontrolden geçmez ve Opus ile de okunur. Bu yalnızca maliyeti artırır, sonucu bozmaz. Opus okuyamazsa (limit, zaman aşımı) Haiku'nun sonucu döner; panelde uyarılarıyla birlikte görünür.

Hangi modelin okuduğu ve neden yeniden okunduğu panelde "Okuma adımları" altında, API'de `olcum.okuma.adimlar` alanında ve sunucu konsolunda (`kademe=… neden="…"`) görünür.

### Model seçimi

Hangi modelin sizin faturalarınızı en hızlı ve doğru okuduğunu kendi dosyalarınızla ölçebilirsiniz:

```
npm run karsilastir -- C:\Bills
npm run karsilastir -- C:\Bills --modeller "haiku>opus,opus"
```

Komut her dosyayı her girdiyle (varsayılan: `haiku`, `sonnet`, `opus`) sırayla okutur ve bir tablo yazar. `haiku>opus` gibi bir girdi, sunucudaki kademeli okumanın aynısıdır.

- **Medyan süre / En uzun:** Bir okumanın süresi.
- **Çoğunlukla aynı alan:** Elimizde doğru cevap anahtarı yok. Bu yüzden bir alan, girdilerin çoğu aynı değeri okuduysa doğru sayılır.
- **Toplamı tutmayan:** Kalemlerin toplamı ara toplamı ya da ara toplam ile KDV genel toplamı tutmuyorsa sayılır.
- **API karşılığı:** Okumaların ücretli API'deki toplam karşılığı. Abonelik limitinden ne kadar düştüğünü kıyaslamak için kullanılır.
- **Yeniden okunan:** Kademeli girdide üst modele giden dosya sayısı.
- Altında girdilerin farklı okuduğu alanlar dosya dosya listelenir. Bunları orijinal faturayla karşılaştırın.

Okumalar sonuçları kaydetmez, ama abonelik limitinizden düşer: 10 dosya ve 3 model 30 okuma demektir. Effort, sunucuyla aynı `CLAUDE_EFFORT` ayarından gelir. Seçtiğiniz modeli sunucuya şöyle verin:

```
$env:CLAUDE_MODEL = "opus"; npm start
```

## Geliştirme

```
npm run db:up      # SQL Server'ı başlatır (testler de ister)
npm run dev        # dosya değişince yeniden başlar
npm test           # sahte Claude CLI ve test veritabanlarıyla testler
npm run typecheck
npm run db:logs    # SQL Server günlüğü
```

Testler gerçek Claude'u hiç çağırmaz; `tests/fixtures/fake-claude.mjs` onun yerine geçer. Veritabanı testleri `.env` içindeki SQL Server'a bağlanır ama kendi veritabanlarını kullanır (`<MSSQL_DATABASE>_test_<n>`, her test işçisi için bir tane); asıl veritabanınıza dokunmaz.

Veritabanı şeması `src/db/migrations/` altındaki numaralı SQL dosyalarıdır. Sunucu açılışta uygulanmamış olanları sırayla uygular ve `sema_surumleri` tablosuna yazar. Şemanın tamamı `001_baslangic.sql` dosyasındadır. Şemayı değiştirmek için sıradaki numarayla yeni bir dosya ekleyin (`002_….sql`); uygulanmış bir dosyayı değiştirmeyin. Veritabanında artık bulunmayan bir dosyanın kaydı varsa (örneğin dosyalar birleştirildiyse) sunucu o veritabanıyla açılmaz; veritabanını silin ya da `MSSQL_DATABASE` ile yeni bir ad verin.

Panelin derleme adımı yoktur: `public/index.html`, `public/css/app.css` ve `public/js/` altındaki ES modülleri doğrudan sunulur.

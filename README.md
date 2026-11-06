# Fatura Okuyucu

PDF veya resim olarak verilen faturayı kendi Claude aboneliğinizle okur ve sonucu sade bir JSON olarak döndürür. JSON'da yalnızca fatura bilgileri ve fatura kalemleri bulunur. Servis yalnızca sizin makinenizde (`127.0.0.1`) çalışır.

Dosyayı iki yoldan gönderebilirsiniz:

- **Panel:** `http://127.0.0.1:4000` adresine dosyayı sürükleyip bırakın.
- **API:** `POST /api/invoices` ucuna gönderin.

Her sonuç `data/invoices/<YYYY-MM-DD>/<id>.json` dosyasına kaydedilir. Panelin "Geçmiş" listesi bu kayıtları gösterir.

## Gereksinimler

- Node.js 24.18 veya üstü
- Claude Code CLI (`claude --version` çalışmalı)
- Claude Pro veya Max aboneliği (API anahtarı gerekmez)

## Kurulum

1. Abonelik token'ı alın:

   ```
   claude setup-token
   ```

   Çıkan `sk-ant-oat01-…` değerini `secrets/claude_oauth_token.txt` dosyasına tek satır olarak kaydedin. Bu dosya git'e girmez. Token'ı kimseyle paylaşmayın.

2. Bağımlılıkları kurun ve servisi başlatın:

   ```
   npm install
   npm start
   ```

3. Tarayıcıda `http://127.0.0.1:4000` adresini açın.

## API

Bir fatura okumak bir dakika kadar sürebilir. Aynı anda en fazla 2 fatura okunur; diğerleri sırada bekler.

Postman kullanıyorsanız kök dizindeki `fatura-okuyucu.postman_collection.json` dosyasını içe aktarın (Import). Koleksiyonda aşağıdaki isteklerin hepsi ve örnek yanıtları var. "Fatura oku" isteklerinde dosyayı Postman'da seçmeniz yeterli.

### Fatura gönderme

Multipart form ile, dosya `file` alanında:

```
curl.exe -F "file=@fatura.pdf" http://127.0.0.1:4000/api/invoices
```

Ya da dosyanın kendisi istek gövdesinde:

```
curl.exe --data-binary "@fatura.pdf" -H "Content-Type: application/pdf" -H "X-File-Name: fatura.pdf" http://127.0.0.1:4000/api/invoices
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

### Kayıtlar

| İstek | Döndürdüğü |
|---|---|
| `GET /api/invoices` | Son 100 kaydın özeti, en yeni başta |
| `GET /api/invoices/<id>` | Kayıtlı sonucun kendisi (yukarıdaki JSON; `olcum.kaynak` her zaman `kayit`) |
| `GET /health` | `{"durum":"ok"}` |

### Hatalar

Hatalı isteklerde gövde `{"hata": {"kod": "...", "mesaj": "..."}}` biçimindedir.

| HTTP | kod | Anlamı |
|---|---|---|
| 400 | `dosya_yok`, `gecersiz_form` | Dosya gönderilmedi veya form bozuk |
| 403 | `izinsiz_host`, `izinsiz_kaynak` | İstek 127.0.0.1/localhost dışından ya da başka bir web sitesinden geldi |
| 404 | `bulunamadi` | Kayıt yok |
| 413 | `dosya_cok_buyuk` | Dosya boyut sınırını aşıyor |
| 415 | `desteklenmeyen_dosya` | PDF veya resim değil |
| 422 | `invalid_output` | Claude'un yanıtı fatura şemasına uymadı |
| 429 | `claude_limit` | Abonelik kullanım limiti doldu; bir süre sonra tekrar deneyin |
| 502 | `claude_failed` | Claude çalıştırılamadı veya hata döndürdü |
| 503 | `claude_auth` | Token geçersiz ya da süresi dolmuş; `claude setup-token` ile yenileyin |
| 504 | `claude_timeout` | Claude zamanında yanıt vermedi |

## Ayarlar

Tüm ayarlar isteğe bağlıdır ve ortam değişkeniyle verilir.

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `PORT` | `4000` | Dinlenen port (her zaman yalnızca 127.0.0.1) |
| `CLAUDE_BIN` | `claude` | Claude Code CLI'nin yolu |
| `CLAUDE_MODEL` | `haiku,opus` | Modeller, en ucuzdan başlayarak virgülle (en çok 4). Sonraki model yalnızca önceki okuma kontrollerden geçmezse çalışır (aşağıda "Kademeli okuma"). Tek model için örneğin `opus` |
| `CLAUDE_EFFORT` | `low` | Claude'un düşünme düzeyi (`low`, `medium`, `high`, `xhigh`, `max`). `default` CLI'nin kendi ayarını kullanır. Karmaşık faturalarda yanlış okuma görürseniz `medium` deneyin |
| `CLAUDE_TIMEOUT_SEC` | `180` | Bir fatura için en uzun bekleme (10–900) |
| `CLAUDE_MAX_CONCURRENT` | `2` | Aynı anda okunan fatura sayısı (1–8) |
| `CLAUDE_OAUTH_TOKEN_FILE` | `secrets/claude_oauth_token.txt` | Token dosyası |
| `CLAUDE_CODE_OAUTH_TOKEN` | (yok) | Token'ı dosya yerine doğrudan verir |
| `DATA_DIR` | `data/invoices` | Kayıt klasörü |
| `MAX_FILE_MB` | `20` | En büyük dosya boyutu (1–32) |

## Güvenlik

- Servis yalnızca `127.0.0.1` adresinde dinler. Başka bir `Host` başlığıyla ya da başka bir siteden (Origin) gelen istekleri reddeder. Böylece tarayıcıda açtığınız bir web sayfası servise fatura gönderemez.
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
npm run dev        # dosya değişince yeniden başlar
npm test           # sahte Claude CLI ile testler
npm run typecheck
```

Testler gerçek Claude'u hiç çağırmaz; `tests/fixtures/fake-claude.mjs` onun yerine geçer.

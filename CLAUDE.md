# Masraf: proje kuralları

Yerel bir masraf yönetimi servisi. Faturayı (PDF veya resim) kullanıcının Claude aboneliğiyle (`claude -p`) okur, masraf formlarını onay akışındaki limitlere göre onaycılara yönlendirir. Tanım listeleri (organizasyon, masraf merkezi, kategori, liste alanlarının seçenekleri) Excel ile içe/dışa aktarılır; fiş alanları ve koşullu zorunluluk kuralları panelden yönetilir. Veriler Docker'daki SQL Server'dadır. Web paneli `public/`, mobil uygulama `masraf-app/` (Expo) içindedir. Kurulum ve fatura API'si için README.md'ye, onay kuralları ve API sözleşmesinin tamamı için `docs/onay-sistemi.md`'ye bakın.

## Yapı

- `src/server.ts`: Giriş noktası. Ayarları okur, veritabanını açar (migration'lar dahil), gerekirse ilk yöneticiyi oluşturur, model başına bir okuyucu kurup kademeye bağlar ve sunucuyu `127.0.0.1` üzerinde (`AG_ERISIMI=yerel` ise bütün IPv4 arabirimlerinde) başlatır.
- `src/config.ts`: Ortam değişkenlerini okur: `loadConfig` (sunucu ve Claude), `loadDbConfig` (`MSSQL_*`), `loadServiceConfig` (oturum, şifre, para birimi, ilk yönetici, mail, hatırlatma, entegrasyon).
- `src/errors.ts`: `HttpError` ve kısayolları (`notFound`, `forbidden`, `conflict`). Mesaj Türkçe, kullanıcıya gösterilir.

`src/db/`: SQL Server katmanı (`mssql` paketi).

- `sql.ts`: Tipli parametreler (`p.int`, `p.str`, `p.money`, …), `query`/`queryOne`/`execute`/`transaction`. Bütün sorgular parametrelidir; SQL'e değer birleştirilmez.
- `database.ts`: Bağlanır (hazır olana kadar bekler), veritabanı yoksa oluşturur, `migrations/NNN_ad.sql` dosyalarını sırayla uygular (`sema_surumleri`). Artık bulunmayan bir dosyanın kaydı olan veritabanını reddeder.
- `migrations/`: Şema. Temel şema `001_baslangic.sql` içindedir (eski dosyalar 2026-11-10'da birleştirildi), entegrasyon tabloları `002_entegrasyonlar.sql` içindedir. Uygulanmış dosya değiştirilmez; değişiklik yeni numaralı dosyayla (`003_….sql`) yapılır.
- `audit.ts`: Denetim kaydı (`denetim_kayitlari`).

`src/auth/`: `password.ts` (scrypt, şifre kuralı), `sessions.ts` (token'ın yalnızca SHA-256 özeti saklanır, kayan süre), `login-limiter.ts` (hatalı giriş kilidi, bellekte).

`src/users/users.ts`: Kullanıcı yönetimi. Son yönetici, akıştaki onaycı ve bekleyen onayı olan kullanıcı korumaları buradadır. Kullanıcının organizasyonu ve masraf merkezleri de burada atanır.

`src/definitions/`: Tanım listeleri ve alanlar (`docs/onay-sistemi.md` bölüm 3 "Fiş alanları…", bölüm 6 "Tanım listeleri", "Fiş alanları").

- `lists.ts`: Organizasyonlar, masraf merkezleri ve liste alanlarının seçenekleri: sayfalı liste, ekleme, değiştirme, kullanılıyorsa silmeme, Excel içe/dışa aktarma.
- `excel-import.ts`: Saf kurallar. Başlık tanıma (masraff.io sütun adları dahil), satır doğrulama, mevcut kayıtlarla karşılaştırma ve içe aktarma planı.
- `list-tx.ts`: Liste yazımlarının kilidi (`sp_getapplock 'masraf_tanim_<liste>'`) ve silinen değerin koşul olduğu kuralların silinmesi.
- `fields.ts`: Alan tanımları ve zorunluluk kuralları (`sp_getapplock 'masraf_alanlar'`). Anahtar addan üretilir ve değişmez; değer girilmiş alan silinmez, pasifleştirilir.
- `display.ts`: Kaydın gösterimi ("kod – ad").

`src/excel/xlsx.ts`: Bağımlılıksız `.xlsx` okuyucu ve yazıcı (`node:zlib`). İlk sayfayı çalışma kitabının ilişkilerinden bulur. ZIP64, şifreli parça, bilinmeyen sıkıştırma ve DOCTYPE reddedilir. Parça sayısı ve açılmış boyut sınırlıdır (zip bombası). Yalnızca düz metin hücre yazar.

`src/approval/`: Onay akışı.

- `flow.ts`: Saf kurallar. Akışın stratejisi (`zincir`: limiti tutara yeten onaycıya kadar herkes, `tek`: yalnızca o onaycı), onay limitleri (artan, kuruş hassas, son onaycı sınırsız), yönlendirme planı (`planApprovals`: gönderenin kendi adımı atlanır, son onay kendisindeyse bir üst onaycıya, en üstteyse yedek yöneticiye geçer).
- `flow-store.ts`: Onay akışları (adlandırılmış, biri varsayılan). Okuma, kaydetme, varsayılan yapma, silme ve kullanıcının akışının bulunması (`loadUserFlow`: atanmış akış, yoksa varsayılan). Değişiklikler `sp_getapplock` ile sıralanır.

`src/expenses/`: Masraf formları.

- `rules.ts`: Saf kurallar. Kim hangi durumda ne yapabilir (`permissions`; yanıttaki `izinler` ve sunucu kontrolü aynı fonksiyondan gelir), onay tutarı (beyan ile fatura toplamından büyüğü).
- `field-rules.ts`: Saf kurallar. Hangi alanın zorunlu olduğu (alanın kendisi ya da koşulu tutan kural) ve formda, faturada, bekleyen dosyada eksik alanlar. Panel (`public/js/fields.js`) ve mobil (`masraf-app/src/lib/fields.ts`) bunu yalnızca yıldız göstermek için aynen tekrarlar; değişirse üçü birlikte değişir. `tests/expenses/field-rules-parity.test.ts` üçünü aynı örneklerle karşılaştırır.
- `forms.ts`: Form servisi. Her işlem bir transaction içinde formu kilitler (`UPDLOCK`), izni yeniden kontrol eder ve geçmişe yazar. Bir formun faturaları (en çok 20) `form_faturalari` tablosundadır; iptal edilen formun faturaları serbest kalır (`aktif = 0`). Okunması bitmeden kaydedilen dosyalar `bekleyen_faturalar`'da baytlarıyla bekler; okununca listenin sonuna eklenir, boş tutar/satıcı doldurulur, sahibine bildirilir ve istenmişse form gönderilir ("okununca gönder"). Kilit sırası: önce form, sonra bekleyen satır.
- `categories.ts`, `export.ts` (CSV: BOM, `;`, formül enjeksiyonu önlemi).
- `pdf.ts`: Onay belgesi PDF'i (pdfkit). Türkçe karakterler için `assets/fonts/` içindeki gömülü Noto Sans kullanılır (OFL lisansı aynı klasörde).

`src/notifications/`: Uygulama içi bildirim ve mail (`docs/onay-sistemi.md` bölüm 7).

- `events.ts`, `mail-templates.ts`: Saf kurallar. Olaydan alıcıya, türe ve metne eşleme; düz metin ve HTML şablonlar (bütün değerler kaçışlı, konu tek satır).
- `store.ts`: Bildirimlerin ve giden mail satırlarının, onları doğuran işlemle aynı transaction'da yazılması; bildirim listesi ve okundu işaretleme.
- `outbox.ts`: Giden kutusu işi. Satırı sahiplenir, SMTP ile gönderir, artan aralıklarla yeniden dener. Hata kaydına SMTP kimlik bilgisi ve mail gövdesi yazılmaz. Yalnızca `MAIL_GONDERIM=smtp` iken çalışır.
- `reminders.ts`: Günlük onay hatırlatması (`HATIRLATMA_*`). Mail kapalıyken de uygulama içi bildirim gönderir.
- `smtp.ts`: nodemailer taşıyıcısı; dosya ve URL eklerine erişim kapalıdır.

`src/integrations/`: Entegrasyonlar (SAP PI/PO'ya gönderim, `docs/onay-sistemi.md` bölüm 9).

- `payload.ts`: Saf kurallar. Seçilebilir kaynak alanlar (form, fiş ve fiş alanları), ad (alias) kuralı, eşleme kontrolü, JSON/XML gövde ve önizleme için örnek veri.
- `form-data.ts`: Bir formun gönderilecek değerleri; faturalar form servisinin `detail` çıktısından (geçerli bilgi) gelir.
- `store.ts`: Entegrasyon kayıtları, kuyruğa ekleme (`queueIntegrations`, son onay ve ödendi ile aynı transaction'da), elle gönderim, gönderim kaydı ve yeniden deneme.
- `sender.ts`: Gönderim işi. Satırı sahiplenir, `fetch` ile gönderir (yönlendirme izlenmez), `5xx`/`408`/`429`/bağlantı hatasını artan aralıklarla yeniden dener, `4xx`'i hemen `hata` yapar. Gövde gönderim anında oluşur.
- `secret.ts`: Basic şifreleri `ENTEGRASYON_ANAHTARI` ile AES-256-GCM şifreler; şifre hiçbir yanıta, kayda ya da hata mesajına yazılmaz.

`src/claude/`: Claude CLI ile konuşan katman.

- `extractor.ts`: CLI çağrısını, ortam yalıtımını ve çıktının çözümlenmesini yapar. Ortak semafor (`createSemaphore`) da buradadır.
- `cascade.ts`: Kademeli okuma. Önce ucuz modelle okur, `src/invoice/checks.ts` kontrolleri tutmazsa sonraki modele geçer.
- `olcum.ts`: Okuma ölçümünün şeması (süre, tur, token, model). Kayda yazılır ve yanıtta `olcum` alanıyla döner.

`src/invoice/`: Faturanın kendisi.

- `schema.ts`: Çıktı şemasının tek kaynağı. Zod şemasından `--json-schema` üretilir. Alan eklemek veya çıkarmak kullanıcı kararıdır.
- `effective.ts`: Saf kurallar. Formdaki faturanın geçerli bilgisi (düzeltme varsa düzeltme), eksik zorunlu alanlar (hangilerinin zorunlu olduğu alan yönetiminden gelir), mükerrer anahtarı ve düzeltme birleştirme/geçmiş notları.
- `checks.ts`: Token harcamayan kontroller (zorunlu alanlar, miktar × birim fiyat, toplamlar). `public/js/invoice.js` içindeki `totalChecks` ile uyumlu tutulur. Buradaki `REQUIRED` okuma kademesi içindir ve alan yönetiminden etkilenmez.
- `file-type.ts`: Dosya türünü ad veya Content-Type'a göre değil, içeriğine (magic bytes) bakarak belirler.
- `storage.ts`: Okuma kayıtları, orijinal dosyalar ve kimin yüklediği (`fatura_kayitlari`, `fatura_dosyalari`, `fatura_yuklemeleri`). Erişim kontrolü (`canRead`) buradadır.

`src/reading/`: Okuma sırası ve izleme. Hepsi bellektedir; sunucu yeniden başlayınca silinir, okunan faturalar veritabanında kalır.

- `reader.ts`: Aynı dosyayı (SHA-256) yeniden okutmaz. Kayıtlı sonucu döndürür ya da süren okumaya katılır. Eş zamanlılık sınırı (`CLAUDE_MAX_CONCURRENT`, 1–4) buradadır; tekli ve çoklu gönderim aynı sırayı paylaşır, kayıttan dönenler sıra beklemez. Yuva kayıt veritabanına yazılana kadar tutulur ve doğrudan sıradakine devredilir; canlı izleme hiçbir an hat sayısından fazla okuma göstermez. Sırada bekleyen dosyanın yerini (`kuyrukSirasi`, `onundeki`) hesaplar; `status`/`file` ile form servisi süren bir okumayı dosya özetinden bulur.
- `pending-reads.ts`: Okunmadan kaydedilen formların dosyalarını (`bekleyen_faturalar`) arka planda aynı okuyucudan geçirir, sonucu form servisine (`settleWaiting`) verir. Sunucu açılışında bekleyenleri yeniden başlatır.
- `batch-queue.ts`: Çoklu gönderimin (`POST /api/invoices/toplu`) dosya bazında durumunu ve kuyruğu kimin oluşturduğunu tutar. Okumayı kendisi sınırlamaz, sırayı `reader.ts` belirler.
- `activity.ts`: Panelden veya API'den gelen her okumanın kaydı, gönderen kullanıcıyla. Canlı izleme bu kaydı gösterir; çalışan yalnızca kendi etkinliklerini görür.

`src/api/`: HTTP katmanı.

- `app.ts`: Express 5 rotaları, Host/Origin koruması, oturum zorunluluğu ve hata eşlemesi.
- `auth.ts`: Oturumu çerezden (panel) ya da `Authorization: Bearer` başlığından (mobil, API) çözer; `requireSession`, `requireRole`.
- `account-routes.ts`, `admin-routes.ts`, `expense-routes.ts`: Oturum/profil, yönetim (kullanıcılar, onay akışı, kategoriler, denetim) ve masraf/onay uçları.
- `definition-routes.ts`, `field-routes.ts`: Tanım listeleri (Excel içe/dışa aktarma dahil) ve alan/kural uçları.
- `notification-routes.ts`: Bildirim uçları ve yöneticinin mail uçları (test maili, giden kutusu, yeniden deneme).
- `integration-routes.ts`: Entegrasyon uçları (ekleme/değiştirme, kaynak listesi, önizleme, elle gönderim, gönderim kaydı).
- `validation.ts`: Zod ile istek doğrulama (Türkçe hata mesajları, `alanlar`).
- `uploads.ts`: Tekli ve çoklu yüklemeyi çözer (`multipart/form-data` veya ham gövde) ve gönderenin panel mi API mi olduğunu belirler (`X-Panel-Etiket`).
- `live.ts`: Canlı izleme akışı (`GET /api/izleme/akis`, Server-Sent Events).
- `network.ts`: Yerel ağ kuralları (`AG_ERISIMI=yerel`): özel IPv4 aralıkları, istemci adresi kontrolü, bilgisayarın yerel ağ adresleri (`Host` kontrolü için, DHCP değişimine karşı 30 sn'de bir yeniden okunur).

Diğerleri:

- `docker-compose.yml`: SQL Server 2022, portu yalnızca `127.0.0.1`'e açık. `npm run db:up` / `db:down`.
- `env.example`: Bütün ayarların şablonu. Yeni ayar eklenirse buraya, README'deki tabloya ve `src/config.ts`'e birlikte eklenir.
- `src/tools/compare-models.ts`: `npm run karsilastir`. Modelleri kullanıcının kendi faturalarıyla süre ve uyuşma açısından karşılaştırır. Gerçek Claude'u çağırdığı için yalnızca kullanıcı çalıştırır.
- `public/`: Derleme adımı olmayan panel (vanilla JS, ES modülleri `public/js/`, stil `public/css/app.css`). Metin her zaman `textContent` ile yazılır (`public/js/dom.js`).
- `masraf-app/`: Expo (React Native) mobil uygulaması. Kendi `package.json`'ı ve README'si vardır; sunucuyla yalnızca `docs/onay-sistemi.md`'deki API üzerinden konuşur.
- `.claude/agents/`: Takım rolleri (backend, veritabanı, web paneli, mobil, kalite denetimi).
- `tests/`: Vitest testleri, `src/` ile aynı klasör düzenindedir. Claude yerine `tests/fixtures/fake-claude.mjs` kullanılır. Veritabanı testleri `tests/db.ts` ile her işçi için ayrı bir veritabanı (`<MSSQL_DATABASE>_test_<n>`) kullanır; SQL Server'ın açık olması gerekir (`npm run db:up`).

## Kurallar

- Node 24, `.ts` dosyaları doğrudan çalışır (type stripping). Import'lar `.ts` uzantılıdır. Yalnızca silinebilir TypeScript sözdizimi kullanılır: enum, namespace ve parametre özelliği yok.
- Kullanıcıya görünen mesajlar Türkçe, kod ve yorumlar İngilizcedir.
- Claude çağrısındaki güvenlik çerçevesi gevşetilmez:
  - Yalnızca `Read` aracı kullanılır, `--dangerously-skip-permissions` yoktur.
  - Claude boş ve geçici bir `CLAUDE_CONFIG_DIR` içinde, izinli ortam değişkenleri listesiyle çalışır.
  - Sunucu yalnızca `127.0.0.1` adresine bağlanır. Tek istisna, kullanıcının `.env` içinde açtığı `AG_ERISIMI=yerel` ayarıdır (varsayılanı kapalı; telefondan erişim için kullanıcı kararı, 2026-11-06). O zaman da yalnızca özel ağ adresleri ve izinli `Host` adları kabul edilir (`src/api/network.ts`); bu kontroller gevşetilmez.
- `--bare` kullanılmaz, çünkü OAuth token'ını yok sayar. Yalıtım boş yapılandırma klasörüyle sağlanır.
- `secrets/` klasörü ve `.env` dosyaları okunmaz, listelenmez. Token ve şifreler sohbete yazılmaz. Gerçek Claude ile deneme çağrısını kullanıcı kendisi yapar.
- Bütün ayarlar `.env`'den gelir; kodda ortama göre değişen sabit değer bırakılmaz.
- Yetki her zaman sunucuda kontrol edilir. İstemciler düğmeleri yanıttaki `izinler` alanına göre gösterir, kuralı kendileri hesaplamaz.
- Onay kuralları (`src/approval/flow.ts`, `src/expenses/rules.ts`, `src/expenses/field-rules.ts`) değişirse `docs/onay-sistemi.md` aynı anda güncellenir.
- Yeni bağımlılık eklemeden önce yerleşik Node API'lerine bakılır. Örneğin multipart, `Request.formData()` ile çözülür.
- Değişiklikten sonra `npm run typecheck` ve `npm test` çalıştırılır. Test silinmez veya zayıflatılmaz.
- Commit ve push yalnızca kullanıcı isterse yapılır.

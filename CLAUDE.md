# Fatura Okuyucu: proje kuralları

Tek amaçlı, yerel bir servis. PDF veya resim faturayı kullanıcının Claude aboneliğiyle (`claude -p`) okur ve `{fatura, kalemler}` JSON'u döndürür. Kurulum ve API için README.md'ye bakın.

## Yapı

- `src/invoice-schema.ts`: Çıktı şemasının tek kaynağı. Zod şemasından `--json-schema` üretilir. Alan eklemek veya çıkarmak kullanıcı kararıdır.
- `src/claude-extractor.ts`: CLI çağrısını, ortam yalıtımını ve çıktının çözümlenmesini yapar.
- `src/cascade.ts`: Kademeli okuma. Önce ucuz modelle okur, `src/invoice-checks.ts` kontrolleri tutmazsa sonraki modele geçer.
- `src/invoice-checks.ts`: Token harcamayan kontroller (zorunlu alanlar, miktar × birim fiyat, toplamlar). Panelin `totalChecks` kontrolüyle uyumlu tutulur.
- `src/invoice-reader.ts`: Aynı dosyayı (SHA-256) yeniden okutmaz. Kayıtlı sonucu döndürür ya da süren okumaya katılır.
- `src/app.ts`: Express 5 rotaları, Host/Origin koruması ve hata eşlemesi.
- `src/olcum.ts`: Okuma ölçümünün şeması (süre, tur, token, model). Kayda yazılır ve yanıtta `olcum` alanıyla döner.
- `src/storage.ts`: Kayıtları `data/invoices/<gün>/<id>.json` olarak saklar.
- `src/config.ts`: Ortam değişkenlerini okur.
- `src/compare-models.ts`: `npm run karsilastir`. Modelleri kullanıcının kendi faturalarıyla süre ve uyuşma açısından karşılaştırır. Gerçek Claude'u çağırdığı için yalnızca kullanıcı çalıştırır.
- `public/`: Derleme adımı olmayan panel (vanilla JS). Metin her zaman `textContent` ile yazılır.
- `tests/`: Vitest testleri. Claude yerine `tests/fixtures/fake-claude.mjs` kullanılır.

## Kurallar

- Node 24, `.ts` dosyaları doğrudan çalışır (type stripping). Import'lar `.ts` uzantılıdır. Yalnızca silinebilir TypeScript sözdizimi kullanılır: enum, namespace ve parametre özelliği yok.
- Kullanıcıya görünen mesajlar Türkçe, kod ve yorumlar İngilizcedir.
- Claude çağrısındaki güvenlik çerçevesi gevşetilmez:
  - Yalnızca `Read` aracı kullanılır, `--dangerously-skip-permissions` yoktur.
  - Claude boş ve geçici bir `CLAUDE_CONFIG_DIR` içinde, izinli ortam değişkenleri listesiyle çalışır.
  - Sunucu yalnızca `127.0.0.1` adresine bağlanır.
- `--bare` kullanılmaz, çünkü OAuth token'ını yok sayar. Yalıtım boş yapılandırma klasörüyle sağlanır.
- `secrets/` klasörü ve `.env` dosyaları okunmaz, listelenmez. Token sohbete yazılmaz. Gerçek Claude ile deneme çağrısını kullanıcı kendisi yapar.
- Yeni bağımlılık eklemeden önce yerleşik Node API'lerine bakılır. Örneğin multipart, `Request.formData()` ile çözülür.
- Değişiklikten sonra `npm run typecheck` ve `npm test` çalıştırılır. Test silinmez veya zayıflatılmaz.
- Commit ve push yalnızca kullanıcı isterse yapılır.

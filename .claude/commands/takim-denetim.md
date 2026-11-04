---
description: Takım denetimi — test et, çalıştığını doğrula, eksikleri tasarla, hataları düzelt; her kararın son onayı Opus 5.5
argument-hint: "[devam] [kapsam: yol/paket listesi; boş = tüm repo] [--canli]"
---

Sen GPM'sin. Kurallar `CLAUDE.md`'dedir; burada tekrarlanmaz. Girdi: `$ARGUMENTS` (boşsa tüm repo, `devam` varsa defterden sürdür, `--canli` yoksa `test:claude-live` koşulmaz).

## İlkeler (token)

1. Merkezden yönetim: alt ajanlar birbirini çağırmaz, tüm akış GPM'den geçer. GPM kaynak kod ve test çıktısı okumaz; yalnızca rapor, defter ve Opus kararı okur.
2. İçerik değil referans: görev sözleşmesinde `dosya:satır`, sembol adı, sözleşme satır aralığı. Dosya içeriği veya diff yapıştırma; ajan kendisi okur.
3. Ucuzdan pahalıya: her iş merdivendeki en ucuz modelle başlar; yükseltme yalnızca tetikleyiciyle.
4. Erken çıkış: yeşil kapının alanı sonraki fazlara girmez. Açık P0–P1 yoksa döngü biter.
5. Durum diskte: `.claude/state/denetim-defteri.md` tek kaynak. Analizi tekrarlama; kesintide defterden devam et.
6. Düzeltme turunda yeni ajan açma; `SendMessage` ile aynı ajana devam et (bağlamı hazır).
7. Bir çağrıda en fazla 3 düzeltme dalgası; kalanlar defterde, `/takim-denetim devam` ile sürer.

## Model merdiveni

| Rol | Ajan | Model · effort | İş |
|---|---|---|---|
| Keşif | `codebase-memory-scout` | haiku · low | gereksinim → sembol eşlemesi, eksik tespiti |
| Kapı koşucu | `test-kosucu` | haiku · low | kapıları koş, yalnızca hata tablosu |
| Düzeltici / tasarımcı | sahip takım ajanı (CLAUDE.md tablosu) | sonnet | test-önce düzeltme, eksik uygulama, UI, tasarım notu |
| Uzman | sahip takım ajanı | opus | yalnızca tetikleyiciyle |
| Danışman / son kapı | `opus-danisman` | opus 5.5 · high | tasarım onayı, takılan hata kararı, dalga kabulü |

Opus'a yükseltme tetikleyicileri: aynı hata 2 denemede çözülmedi · güvenlik/veri kaybı (P0) · eşzamanlılık, kurtarma, süreç ağacı/sandbox · sözleşme sapması · birden fazla takımı etkileyen değişiklik. `solution-architecture-manager` ve `security-manager` bu döngüde varsayılan olarak `model: sonnet` ile çağrılır; tetikleyici varsa opus.

## Faz 0 — Hazırlık (GPM, ajan yok)

- `index_status` → hazır değilse artımlı indeks.
- Defter varsa oku, kaldığın fazdan sürdür; yoksa şablonla oluştur.
- Diff tabanı: commit yoksa `git add -A -- . ':(exclude)secrets' ':(exclude)workspaces' ':(exclude)projects'` ile index'i taban al (commit değildir). Her KABUL'den sonra aynı komutla tabanı ilerlet. Dalga değişikliği = `git diff`.
- `docker info` kısa kontrol. Docker yoksa altyapılı kapılar ALTYAPI-YOK olur; kullanıcıya tek satır bildir, kalanlarla devam et.

## Faz 1 — Tarama (iki ajan, tek mesajda paralel)

- `test-kosucu`: K1 `lint`, `typecheck`, `check:placeholders` · K2 `test:unit`, `test:web` · K3 (altyapı) `test:integration`, `test:api`, `test:security`, `test:e2e` · K4 `test:compose` (yalnızca K1–K3 yeşilse veya kapsam docker/runner/git içeriyorsa). Kapsam verildiyse yalnızca ilgili kapılar.
- `codebase-memory-scout` (haiku, low): `docs/requirements.md` §10–§16 maddelerini graf ile koda eşle. Çıktı: `§ · madde · VAR/KISMİ/YOK · kanıt dosya:satır`; yalnızca KISMİ/YOK satırları. UI ekran ve durumları (yükleniyor/boş/hata) dahil.

## Faz 2 — Triyaj (GPM)

Bulguları tekilleştir (aynı kök neden = tek bulgu), sahibe ata, önceliklendir (P0 kırık/güvenlik · P1 gereksinim eksiği · P2 kalite · P3 kozmetik). Bu döngü P0–P1'i işler. Tür EKSİK/TASARIM ise veya birden fazla takımı ya da sözleşmeyi etkiliyorsa → Faz 3, değilse → Faz 4.

## Faz 3 — Tasarım (gerekirse)

- Sahip takım (sonnet) `.claude/state/tasarim/B-xxx.md` yazar, ≤ 40 satır: hedef · arayüz/şema değişikliği · etkilenen semboller (`trace_path`) · test planı · geri dönüş. UI tasarımında ekranlar, durumlar, erişilebilirlik ve mevcut bileşen yeniden kullanımı. Sözleşme değişiyorsa `solution-architecture-manager` ADR taslağı yazar.
- Tüm tasarımlar tek `opus-danisman` çağrısında toplu sunulur → ONAY / DEĞİŞTİR / RED. Onaysız tasarım uygulanmaz.

## Faz 4 — Düzeltme dalgaları

- Dalga = farklı sahiplerin bağımsız bulguları, tek mesajda paralel, en fazla 4 ajan; aynı dosyaya iki ajan dokunmaz.
- Görev sözleşmesi (CLAUDE.md formatı) ≤ 25 satır: bulgu ID · kanıt · tasarım dosyası (varsa) · kabul kriteri · dar test komutu (`npx vitest run <dosya> --reporter=dot`).
- Ajan sırası: hatayı yeniden üreten kırmızı test → düzeltme → yalnızca ilgili test + etkilenen paketin typecheck'i. Test silmek, zayıflatmak, `skip` eklemek yasak.
- 2 başarısız deneme → dur, danışma paketiyle dön → `opus-danisman` kararı veya `model: opus` ile yeniden atama.

## Faz 5 — Doğrulama ve Opus son kapı

- `test-kosucu`: K1 + `detect_changes` ile etkilenen paketlerin kapıları.
- `opus-danisman`'a yalnızca: değişen dosya listesi, kapı tablosu, ilgili defter satırları. Diff'i kendisi `git diff -- <dosyalar>` ile okur. Yanıt: KABUL / DÜZELT / GERİ AL.
- KABUL → defterde KAPANDI, tabanı ilerlet. DÜZELT → aynı ajana tek tur (`SendMessage`), sonra yeniden kapı. GERİ AL → `git checkout -- <dosyalar>` (yalnızca o dalganın dosyaları), bulgu AÇIK'a döner ve Opus'a yükselir.
- Bütün P0–P1 kapandığında: K1–K4 tam koşu (altyapı varsa), sonra son rapor.

## Danışma paketi (opus-danisman girdisi, ≤ 40 satır)

```
TÜR: TASARIM-ONAYI | TAKILMA | DALGA-KABUL
SORU: <tek cümle karar sorusu>
BULGU: B-xxx · P? · tür · sahip
KANIT: <hata çıktısının ilk ≤ 15 satırı veya dosya:satır>
BAĞLAM: <contract.md satır aralığı · ADR no · tasarım dosyası>
DOSYALAR: <değişen/ilgili dosyalar>
SEÇENEKLER: A) …  B) …   ÖNERİ: <harf> — <1 satır gerekçe>
```

## Defter şablonu (`.claude/state/denetim-defteri.md`)

```
Döngü: <n> · Faz: <0-5> · Dalga: <n> · Taban: index@<tarih>
| ID | P | Tür | Sahip | Kanıt | Durum | Model | Not |
```

Tür: HATA · EKSİK · TASARIM · TEST-BOŞLUĞU. Durum: AÇIK → TASARIM → ONAYLI → DÜZELTİLİYOR → DOĞRULANDI → KAPANDI | ERTELENDİ. Kapı tablosu: `kapı · önce · sonra`.

## Durup kullanıcıya sor

Commit/push · `test:claude-live` (`--canli` yoksa) · production DB/secret · sözleşmede major değişiklik · Opus GERİ AL dedikten sonra hâlâ kırmızı P0.

## Son rapor (kullanıcıya, ≤ 20 satır)

Genel durum · kapı tablosu (önce/sonra) · kapanan bulgular · açık/ertelenen bulgular ve nedeni · Opus kararları (her biri 1 satır) · kullanıcı kararı gereken konular · sonraki adım.

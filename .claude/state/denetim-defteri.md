Döngü: 3 · Faz: 1 (B-017 CLI doğrulama deneyi) · Dalga: 0 · Taban: index@2026-11-05 (döngü 2 sonu, commit yok)

Döngü 2: KAPANDI (3 dalga, tüm kapılar YEŞİL). Döngü 3 kapsamı: kullanıcı isteği B-017 (abonelikle çalışma, API anahtarı zorunlu olmasın), ardından B-015 ve B-016.

Döngü 1: KAPANDI (P0/P1 yok). Döngü 2 kapsamı: kullanıcı isteğiyle P2–P3 (B-001…B-008).

Kapsam: tüm repo · `--canli` yok (test:claude-live koşulmaz) · Docker: 29.9.2 Desktop (altyapılı kapılar açık)

## Kapılar

| Kapı | Önce | Sonra |
|---|---|---|
| lint | YEŞİL | YEŞİL |
| typecheck | YEŞİL | YEŞİL |
| check:placeholders | YEŞİL (245 dosya, 0 bulgu) | YEŞİL |
| test:unit | YEŞİL (1575/0/2 atlanan, 76 dosya) | YEŞİL 1611/0/3 (77 dosya) |
| test:web | YEŞİL (81/0/0, 14 dosya) | YEŞİL 148/0/0 (22 dosya) |
| test:integration | YEŞİL (208/0/24 atlanan; 32 dosya, 4 dosya atlandı; 640 s) | YEŞİL 218/0/26 · leaks.json clean |
| test:api | YEŞİL (77/0/0, 10 dosya; 59 s) | YEŞİL 77/0/0 |
| test:security | YEŞİL (252/0/0, 12 dosya; dependency-audit 0 critical; 52 s) | YEŞİL 252/0/0 |
| test:e2e | YEŞİL (12/0/0, 6 dosya; 162 s) | YEŞİL 12/0/0 |
| test:compose | YEŞİL (40 kontrol, smoke PASSED; 160 s) | YEŞİL 40 kontrol |
| test:linux | koşulmadı (D1) · D2 ilk koşu KIRMIZI 2 FAIL | YEŞİL root 446/0/6 · uid1000 18/0/0 |

Tam koşu (D2, dalga 2 sonrası): lint, typecheck, placeholders YEŞİL · unit 1597/0/2 · web 148/0/0 · integration 217/0/26 (+9 leak-detection, +2 guard skip) · api 77/0/0 · security 252/0/0 · e2e 12/0/0 · compose 40 kontrol YEŞİL · test:linux KIRMIZI (2 FAIL; bu denetimde ilk koşu, taban yok) · leaks.json clean (33 worker kaydı).
Dalga 1 sonrası (D2): lint, typecheck, placeholders YEŞİL · unit 1579/0/2 · web 148/0/0 (22 dosya) · security 252/0/0 · integration 208/0/24. Kırmızı yok.

## Bulgular

| ID | P | Tür | Sahip | Kanıt | Durum | Model | Not |
|---|---|---|---|---|---|---|---|
| B-022 | P2 | EKSİK | Worker | Opus 8.5: kota bitmesi ve süresi dolmuş token için outcome eşlemesi | ERTELENDİ | — | Canlı D-8 gerekiyor |
| B-021 | P3 | KALİTE | Platform/kullanıcı | `secrets/README.md` çalışma ağacında silinmiş (git status ` D`); generate-secrets.mjs README'ye değinmiyor | KAPANDI | — | Kullanıcı 'geri yükle' dedi → git checkout ile geri yüklendi. generate-secrets.mjs'te rm/unlink/readdir yok; silme script'ten kaynaklanmıyor |
| B-018 | P1 | HATA (güvenlik) | Worker + Security | Deney (B-017-deney.md): mevcut üründe ANTHROPIC_API_KEY Claude'un Bash aracında ve cbm MCP env'inde görünüyor. OAuth token'ı CLI çocuk env'inden siliyor, ama Linux'ta aynı uid'li Bash /proc/<claude>/environ'dan okuyabiliyor | TASARIM | opus | B-017 tasarımına dahil. FD yolu (CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR) yalnız Linux'ta çalışıyor |
| B-019 | P1 | HATA | Worker | Deney: --bare araçları Bash, Edit ve Read'e indiriyor (Glob, Grep, Write yok). validateInit eksik aracı, skills/agents/plugins/memory_paths'i ve bare dışındaki hook olaylarını kontrol etmiyor | TASARIM | opus | B-017 tasarımına dahil (non-bare'de tam araç seti ve sıkı init doğrulaması) |
| B-020 | P2 | HATA | Security | packages/security WINDOWS_BASE_ENV, worker'ın gerçek APPDATA ve LOCALAPPDATA değerlerini Claude'a geçiriyor (Windows local mod) | AÇIK | — | B-017 tasarımında değerlendirilecek |
| B-017 | P1 | EKSİK (kullanıcı gereksinimi) | Mimari + Worker + Security + Platform | Kullanıcı: "local claude ile kullanmak için geliştirdim, API anahtarı istememeli". ADR-0016 --bare kullanıyor; CLI 2.1.318 --help: bare'de auth yalnız ANTHROPIC_API_KEY/apiKeyHelper. config.ts:630-634 bare=false yalnız development'ta. compose-check ve docker-compose.yml:257,458 API anahtarını zorunlu tutuyor | ONAYLI (D0 + kullanıcı 3.0.0 onayı bekleniyor) | opus | Kullanıcı kararı (2026-11-05): `claude setup-token` ile CLAUDE_CODE_OAUTH_TOKEN varsayılan olacak, API anahtarı isteğe bağlı kalacak (ikisi de desteklenecek). Yeni ADR ve sözleşme değişikliği gerekiyor |
| B-016 | P3 | KALİTE | Mimari | macOS os.tmpdir() ~49 B, local soket bütçesi ≤ 20 B (eski sorun) | ERTELENDİ | haiku | docs/known-issues.md'ye 'macOS local mod desteklenmiyor' notu; isteğe bağlı olarak B-015 ile anlaşılır erken hata |
| B-015 | P2 | EKSİK (güvenlik) | Worker (orchestrator) | B-014 raporu: reused_workspace_index yolunda ve task_index başarısız olunca Claude mcp.json ile başlıyor; senkron claudeMcpConfig (manager.ts:629) dizin doğrulaması yapmıyor. Koruma önceki doğrulamaya ve CBM'in ata dizin kontrolüne (ADR-0034 m.2) dayanıyor | ONAYLI | opus | Opus K7: sonraki çağrının ilk kaydı. Tasarım `ensureClaudeMcpRuntime` + tmpdir sticky/sahip kontrolü + sözleşme metni |
| B-012 | P1 | HATA | Worker | test:linux pipeline.test.ts:90 (task_index:failed) — dalga 2 regresyonu: mcp-real (root) `/tmp/orc-cbm-rt`'yi root 0700 bırakıyor, uid 1000 mkdir edemiyor | KAPANDI | opus | scripts/test-linux.mjs: uid 1000 koşusu ayrı TMPDIR=/tmp/w (0700, uid 1000) kullanıyor |
| B-013 | P2 | HATA | Mimari | tests/unit/shared/config.test.ts:314 — prod ortamında CBM_CACHE_DIR=/tmp/... (33 B), config.ts:674 sınırı 26 B; win32'de kontrol atlandığı için yalnız Linux'ta kırmızı; 89a328e'den beri var | KAPANDI | sonnet | Test verisi compose değeri `/var/lib/orc/cbm-cache` olacak + 27 B ret assert'i; üretim formülü değişmez |
| B-014 | P1 | HATA (güvenlik) | Code Intelligence | packages/mcp-manager/src/manager.ts:165,203 — local mod `<tmpdir>/orc-cbm-rt` ebeveyni uid'e özel değil, sahiplik ve symlink kontrolü yok (kullanıcılar arası /tmp riski, CWE-377) | KAPANDI | opus | Öneri: `orc-cbm-rt-<uid>`, mkdir sonrası lstat ile sahip=getuid ve symlink değil kontrolü; sözleşme §10.11 local metni güncellenecek |
| B-009 | P2 | TEST-BOŞLUĞU | QA | sızıntı guard'ı yalnız `orc-test-` önekini tarıyor | KAPANDI | sonnet | `orc-gm-int-` ve `orc-wk-` önekleri `orc-test-` altında birleştirilmeli (Opus: sonraki döngünün ilk kaydı) |
| B-010 | P3 | KALİTE | Platform | scripts/test-linux.mjs | KAPANDI | sonnet | Script, ORC_TEST_REAP ve ORC_TEST_LEAK_STRICT değişkenlerini konteynere geçirmiyor |
| B-011 | P3 | KALİTE | QA | tests/helpers/common/leak-fixtures.ts cleanup | KAPANDI | opus (SendMessage) | Yetim süreç, başlangıç zamanı doğrulanmadan PID ile öldürülüyor |
| B-001 | P2 | TASARIM | Mimari | contract.md:2461 (§10.11 m.5) ↔ validation.ts:26,46; ADR-0034 | KAPANDI | sonnet | Sözleşmeye `CBM_RUNTIME_DIR` eklenmeli (doküman sapması, kod ADR'ye uygun) |
| B-002 | P2 | HATA | Worker Platform | local.ts:242-243 ↔ lease-manager.ts:416 | KAPANDI | opus | Local modda `validateSpawnEnvPaths` çağrılmıyor; CBM_RUNTIME_DIR lease-içi kontrolü yalnız lease-manager'da |
| B-003 | P2 | TEST-BOŞLUĞU | Worker Platform | validation.ts:244-264; sandbox-escape.test.ts:137-148 | KAPANDI | opus | `resolveInLease` için UNC ve farklı sürücü harfi testi yok. Not: realpath+isPathInside kullanıyor (resolveWithin'den güçlü); CLAUDE.md kuralı ifadesi uyarlanabilir |
| B-004 | P2 | TEST-BOŞLUĞU | Frontend | apps/web sayfaları | KAPANDI | sonnet | 8 sayfada sayfa düzeyi test yok: Dashboard, ProjectDetail, TaskDetail, Agents, Teams, System, Audit, Account |
| B-005 | P2 | TEST-BOŞLUĞU | QA | tests/* afterAll | KAPANDI | sonnet | Merkezi worktree/branch/process temizliği yok; her test kendi afterAll'ında temizliyor |
| B-006 | P2 | TEST-BOŞLUĞU | QA | test:integration 24 atlanan / 4 dosya | KAPANDI | sonnet | Atlanma nedeni (platform koşullu mu?) doğrulanmadı; unit'te de 2 atlanan var |
| B-007 | P3 | HATA | Platform | package.json `test:security` zinciri | KAPANDI | haiku | `npm run test:security -- --reporter=dot` argümanı dependency-audit script'ine sızıyor ("Unknown option") |
| B-008 | P3 | KALİTE | Platform+QA | bayat `.gitkeep` dosyaları (8 silindi) | KAPANDI | haiku | Kozmetik |

## Kararlar (Opus)

- Döngü 1: Opus çağrılmadı. Tasarım, takılma ya da dalga kabulü gerektiren bir bulgu çıkmadı.
- D2 TASARIM-ONAYI (opus-danisman):
  - K1 B-001 ONAY(A): 2.2.1 patch, ADR yok. Ret kodu `env_rejected` (lease-manager.test.ts:320-328 ile birebir). Changelog satırı §10.3, §10.11 ve ADR-0034/0035'e atıf yapacak.
  - K2 B-002 ONAY(A): local modda ek kısıt yok. local.ts:1-3 yorumu düzeltilecek (local modda validateSpawnEnvPaths yok, yalnız tür ve mutlak yol kontrolü). B-001 ile aynı turda.
  - K3 B-005 DEĞİŞTİR(C+): yalnız bu koşunun diff'inde yeni çıkan öğeler silinir. Kök realpath(os.tmpdir()) olur ve resolveWithin ile sabitlenir; `orc-test-` prefiksi zorunlu; lstat kullanılır. Süreç seçimi: fake-claude.mjs mutlak yolu VE (PID zinciri vitest'e çıkar ya da ORC_TEST_RUN_ID işareti var); Windows'ta PID zinciri zorunlu. PowerShell spawn ile çağrılır (shell:false, -NoProfile -NonInteractive). Tarama başarısızsa `scanUnavailable` raporlanır, ORC_TEST_LEAK_STRICT=1 ise FAIL. DB yalnız raporlanır. leak-detection testi kendi sızıntısını temizler. Model opus. İlk koşu REAP kapalı.
  - K4 B-006 DEĞİŞTİR(A, mevcut katman): docker/Dockerfile:94-115 `cbm` aşaması yeniden kullanılır (--target cbm → COPY --from). TEST_IMAGE etiketine CBM sürümü eklenir (ensureTestImage:74 eski imajı sessizce kullanmasın). Script konteynere CODEBASE_MEMORY_MCP_BIN ve ORC_REQUIRE_CBM=1 geçirir. mcp-real.test.ts DEFAULT_TARGETS'a eklenir. İki testte ikili yoksa ve ORC_REQUIRE_CBM=1 ise FAIL. (c) test-setup.test.ts:74 skipIf ve dependency-rules.test.ts:133 stub koşulu silinir. arm64 kısıtı belgelenir.
  - Ek: validation.ts sameRoot değişikliği (B-003) ayrı DALGA-KABUL incelemesi ister.
- D3 TASARIM-ONAYI (opus-danisman):
  - K8 B-017 DEĞİŞTİR: ADR-0036 ve dalga planı doğru. Accepted için ek şartlar:
    - D-7(a) (gerçek token regex'e uyuyor mu, çevrimdışı ve yalnız boolean) D0'a alınır.
    - D-1(b)'ye /proc/<claude>/mem denemesi ve ptrace_scope kaydı eklenir.
    - @orc/logger redaksiyonu (sk-ant-oat, CLAUDE_CODE_OAUTH_TOKEN*, credentialFd, b64) Platform kapsamına girer.
  - 8.1 --restricted: D-4 geçerse alınır ve probe'un zorunlu bayraklarına girer.
  - 8.2: oauth modunda ANTHROPIC_API_KEY varsa ConfigError; mesajda yalnız ad yazılır.
  - 8.3: operatör düğmesi yok; sürüm başına sabit tablo; runbook'a CLI güncelleme notu.
  - 8.4: security_violation, kural kodu tool_missing.
  - 8.5: outcome eşlemesi ertelenir (ayrı B kaydı). 401/'Not logged in' durumunun retry fırtınası üretmediği testle kanıtlanır; runbook'a yenileme adımı yazılır.
  - 8.6: B-020 izolasyonu yalnız claude ve probe için; known-issue olarak kaydedilir.
  - 8.7: 3.0.0 MAJOR doğru (contract.md:8) → kullanıcı onayı gerekiyor.
  - 8.8: api_key modundaki sızıntı kabul edilebilir kalıntı risk (bugün de var); threat-model'de 'önerilmez' diye işaretlenir, başlangıçta tek seferlik warn yazılır.
  - D0 geç/kal ölçütleri: D-1 (a/b/c), D-2, D-4, D-6, D-7(a). Engelleyici: D-7(a) ve D-1 sonuçlanmadan Dalga 1 başlamaz.
  - Modeller: D0, Worker A/B ve threat-model opus; shared, security env, platform, fake-claude, security testleri ve B-015 sonnet.
  - K9 B-015 ONAY. 9.1: requireIndex de fail-closed'ı tetikler. 9.2: aynı 3.0.0'a girer (ADR-0037, ayrı changelog alt başlığı); B-015.md:13'teki ADR numarası 0037 olarak düzeltilecek; argv'deki mcp===null kuralı unit testle sabitlenecek.
- D2 TASARIM-ONAYI-2 (opus-danisman):
  - K5 B-014 DEĞİŞTİR(B+): Linux'ta `orc-cbm-rt-<getuid>`, win32'de son ek yok. prepareDirs'te (manager.ts:203) mkdir sonrası ebeveyn ve <16hex> dizini lstat ile doğrulanır: dizin ve symlink değil, uid=getuid, (mode&0o077)===0; tutmazsa OrcError. chmod ile düzeltme yok, fallback yok. Doğrulama spawn öncesi yolda olmalı (:560, :303); claudeMcpConfig (:629) yeterli değil. ADR-0035 bütçe testi 11 B'lik uid ile yapılır. Sözleşme local metni 2.2.1 içinde güncellenir. Model opus.
  - DOĞRULAMA: test-linux.mjs'teki TMPDIR=/tmp/w ayrımı B-014'ten sonra KALDIRILACAK. 4 vakalık unit test şart (yabancı sahipli ebeveyn, symlink, 0o755, yabancı sahipli alt dizin), spawn çağrılmamalı.
  - K6 B-009 ONAY(B): önek listesi + mkdtemp son eki. Senkron test mkdtemp( ve join(tmpdir(),'…') literal'lerini tarar; literal olmayan önekte FAIL verir; listedeki hiçbir önek orc-cbm-rt-<uid> ve orc-test-home ile eşleşmemeli. K3 koşulları REAP için aynen geçerli. Model sonnet.
- D2 DALGA-KABUL dalga 3 (opus-danisman): G6–G10 hepsi KABUL; kabul tam koşunun yeşil olmasına bağlı.
  - `mcp_unavailable` + `reason: path_escape` koddan doğrulandı (security/src/errors.ts:11, manager.ts:73-82).
  - B-013 test verisi düzeltmesi, zayıflatma değil.
  - B-009 istisna listesi kaçak yaratmıyor.
  - K7 B-015: A, sonraki `/takim-denetim devam` çağrısının ilk kaydı (P2, opus). Tasarım: McpManager'a async `ensureClaudeMcpRuntime(scope)` eklenir ve orchestrator Claude spawn'ından önce çağırır. MCP_REQUIRED ise fail-closed, değilse mcp.json olmadan başlatılır. Ek kontrol: os.tmpdir() sahibi root ya da uid olmalı ve sticky olmalı ya da o+w olmamalı; aynı şart contract 2.2.1 local metnine eklenir.
  - macOS desteklenen platform değil (tmpdir ~49 B > 20 B; eski bir sorun) → docs/known-issues.md'ye P3 not düşülecek.
- D2 DALGA-KABUL dalga 2 (opus-danisman): G1–G5 hepsi KABUL; kabul, tam koşunun yeşil olmasına bağlı.
  - B-005 güvenliği: silme yalnız `certain` iken yapılıyor (global-teardown.ts:202-215). Silmeden önce pinLeakDir, prefiks, lstat, inode, link ve gitdir kontrolleri var (leak-ledger.ts:657-705). Öldürmeden önce taze tarama, PID ve başlangıç zamanı doğrulanıyor; sinyal yalnız tek sürece gidiyor (717-771). Tüm spawn'lar shell:false. STRICT kapalıyken koşu sonucu etkilenmiyor. Deneysel API bozulursa sistem öldürmeden yalnız uyarıya düşüyor.
  - B-006: PENDING sıkılaştırması kabul edildi. İki atlama meşru (mcp-real.test.ts:100 ve cbm-anchor.test.ts:280 yalnız "ikili yok + REQUIRE" durumunda koşan guard testleri).
  - Erteleme kararları: test-linux.mjs'in REAP/STRICT değişkenlerini geçirmesi ertelendi. `orc-gm-int-`/`orc-wk-` önek birleştirmesi ertelendi ama sonraki döngünün ilk kaydı olacak (sonnet). Not: leak-fixtures.ts cleanup PID'i başlangıç zamanını doğrulamadan öldürüyor; engelleyici değil.
- D2 DALGA-KABUL dalga 1 (opus-danisman): tüm gruplar KABUL. sameRoot yalnız kökleri farklı yolları reddediyor; meşru lease yolları etkilenmiyor (eşlenmiş sürücü acquire'da realpath'le normalleşiyor, local.ts:186; `\?\` öneki realpath'te kalkıyor; sürücü harfi büyük/küçük farkı toLowerCase ile karşılanıyor). POSIX'te davranış birebir aynı. it.runIf(win32) Linux'ta kapsam kaybı yaratmıyor. 8 web testinin assert'leri güçlü, mock sızıntısı yok.

## Olay günlüğü

- Faz 0: indeks ready (7364 düğüm), taban index'e alındı, defter oluşturuldu.
- Faz 1: başlatıldı — test-kosucu (K1–K4, haiku/low) + codebase-memory-scout (§10–§16 eşleme, haiku/low) paralel. Sonuç bekleniyor.
- Faz 1: scout eşlemeyi TAMAMLAMADI (Tier 1 yalnızca pozitif kanıt verir, YOK iddia edemez). Yükseltme → codebase-memory (Tier 2, sonnet/low) ×2 paralel: A=§10–§13, B=§14–§16+web UI. Scout pozitif kanıtları A'ya referans olarak geçildi.
- Faz 1: KESIF-A ve KESIF-B tamam, YOK maddesi yok. Doğrulanmamış KISMİ'ler için aynı ajanlara devam (SendMessage) gönderildi:
  - A: launcher shell:false/env/cwd (olası P0), proc-scan SIGTERM→SIGKILL testi, prompt katman 3/7 ve uyarı, /tests route testleri, projects.ts.
  - B: SSE sahiplik testi (olası P1-güvenlik), MSSQL least-privilege, 9 sayfanın loading/empty/error durumu, States/NewTask placeholder, test cleanup.
- KESIF-A devam tamam: spawn güvenliği VAR (process.ts:158,449,576 shell:false + args dizisi; local.ts:242 validateSpawnEnv; local.ts:243 resolveInLease cwd). Kademeli kapatma testleri VAR (proc-scan.test.ts:108, kill.test.ts:69,99). Prompt 8 katman VAR (prompt.test.ts:106). /tests route'ları VAR (tasks.test.ts:269-273). P0 adayı kapandı.
  - Kalan aday: projects CRUD API testi belirsiz (projects.ts:29-196 uçları var; admin-catalog.test.ts:174 yalnızca index-status) → TEST-BOŞLUĞU.
  - Not (P2 adayı): cwd sabitleme `resolveInLease` ile yapılıyor, CLAUDE.md `resolveWithin` diyor. Eşdeğerlik doğrulanmadı. validateSpawnEnv allowlist'i contract §10.3'e karşı doğrulanmadı.
- KESIF-B devam tamam, güvenlik açığı yok: SSE görünürlük kontrolü VAR (sse/stream.ts:327,525; sse.test.ts:127,305). MSSQL least-privilege VAR (0002_roles_and_grants.sql:16-47; db-separation.test.ts:73,83). Placeholder yok (States.tsx:3 yorum, NewTaskPage.tsx:260 HTML niteliği).
  - UI durumları: eksik durum kanıtlanmadı. En zayıf kanıt AuditPage, TaskListPage, TaskDetailPage'de (5'er eşleşme).
  - Test cleanup: merkezi worktree/branch/process temizliği yok, her test kendi afterAll'ında yapıyor → P2 adayı.
- Gereksinim eşlemesi sonucu: P0/P1 bulgu YOK. Tüm adaylar P2 (test boşluğu/tutarlılık). Kapı sonuçları bekleniyor.
- Oturum 2 (devam): Faz 0 yeniden — indeks ready (7364 düğüm), Docker 29.9.2, test container'ları (mssql-test, redis-test) healthy. Taban = HEAD b5e7dba (index temiz). K3 kesintide kalmıştı → test-kosucu K3 (+K4 koşullu) yeniden başlatıldı.
- KESIF-C tamam (codebase-memory Tier 2), P0/P1 YOK:
  - Env allowlist: çocuğa DB/Redis/secret/`*_FILE` geçemez (validation.ts:62-68 red, local.ts:247 yalnız spec.env; testler validation.test.ts:68-70, sandbox-escape.test.ts:154-165). ANTHROPIC_API_KEY yalnız claude türüne açık, sözleşmeye uygun. P0 adayı kapandı.
  - P2: contract §10.11 m.5 (contract.md:2461) `CBM_RUNTIME_DIR`'i içermiyor; kod (validation.ts:26,46) ve ADR-0034 içeriyor → sözleşme güncellemesi.
  - P2: local.ts:242-243 `validateSpawnEnvPaths` çağırmıyor (lease-manager.ts:416 çağırıyor) → local modda CBM_RUNTIME_DIR lease-içi kontrolü yok.
  - P2: `resolveInLease` (validation.ts:244-264) resolveWithin'i değil realpath+isPathInside'ı kullanıyor (daha güçlü, realpathWithin'e eşdeğer); UNC ve farklı sürücü harfi testi yok.
  - Projects CRUD test boşluğu adayı DOĞRULANMADI: 9 ucun hepsi tests/api altında testli (admin-catalog.test.ts:134-180 vb.). Aday kapandı.
- Aday P2 (bu döngü dışı, ERTELENDİ adayı): 7 sayfada sayfa düzeyinde test yok (Dashboard, ProjectDetail, TaskDetail, Agents, Teams, System, Audit, Account). Ayrıca bayat `.gitkeep` dosyaları var.
- K3+K4 tamam (test-kosucu): integration, api, security, e2e ve compose YEŞİL, başarısız test ve altyapı hatası yok. Loglar session scratchpad'inde (k3-*.log, k4-compose.log).
- Faz 2 triyaj: P0/P1 = 0. P2 ×6 ve P3 ×2 ERTELENDİ (B-001…B-008). İlke 4 (erken çıkış) gereği Faz 3–5 açılmadı. Döngü 1 KAPANDI.
- Döngü 2 başladı (kullanıcı: "eksikleri tamamla"). Triyaj: B-001 (sözleşme) ve B-005 (çapraz takım test altyapısı) → Faz 3; B-006 → QA analizi (ipucu: `test:linux` Linux-only suite'leri koşar). Dalga 1: B-002+B-003 (Worker, opus — sandbox tetikleyicisi), B-004 (Frontend, sonnet), B-007+B-008 (Platform, haiku). Tasarımlar paralel: B-001 (Mimari, sonnet), B-005+B-006 (QA, sonnet).
- B-001 tasarımı hazır (.claude/state/tasarim/B-001.md): contract 2.2.0→2.2.1 patch, §10.11 m.5'e CBM_RUNTIME_DIR (yalnız mcp, mutlak, runner modunda lease içi). ADR gerekmez (ADR-0034/0035 kapsıyor). Bulgu: local modda runtime dizini tasarım gereği lease dışında (mcp-manager manager.ts:160-166) → B-002 büyük olasılıkla "beklenen davranış"; Worker ajanına iletildi.
- B-005/B-006 tasarımları hazır (.claude/state/tasarim/B-005.md, B-006.md). B-006 sınıf sayıları: a=14 (test:linux koşuyor, scripts/test-linux.mjs), b=4 (cbm-anchor.test.ts:278 ve mcp-real.test.ts:95 Linux imajında CBM ikilisi yok; 2 claude-live testi API key'e bağlı), c=2 (test-setup.test.ts:74, dependency-rules.test.ts:133 gerekçesiz koşullu skip). B-005: global-teardown ile sızıntı raporlama; temizlik için ORC_TEST_REAP=1 gerekiyor; yalnız QA yolları. Opus toplu onayı B-002 kararı gelince yapılacak.
- B-007/B-008 Platform tamam: test:security zinciri yeniden sıralandı (placeholder → audit → vitest), `npm run test:security -- --reporter=dot` EXIT=0, lint EXIT=0. `docs/operations/.gitkeep` git rm ile silindi. Kalan bayat .gitkeep'ler: tests/{api,claude-live,e2e,fixtures,integration,security}/ ve docs/security/ (dizinlerde izlenen dosya var) → QA uygulama görevine eklenecek. docker/, projects/, secrets/, workspaces/ .gitkeep'leri bilinçli olarak korundu (gitignore negasyonu ya da kapsam dışı).
- B-004 Frontend tamam: 8 sayfa testi eklendi (apps/web/src/pages/**/<Page>Page.test.tsx, toplam 67 test). Sayfalarda eksik durum yok, kod değişmedi. test:web 22 dosya/148 test geçti. Son lint düzeltmesinden sonra test:web tam koşulmadı → Faz 5'te yeniden koşulacak. typecheck ve eslint temiz.
- B-002/B-003 Worker (opus) tamam. B-002 beklenen davranış: local modda runtime dizini bilinçli olarak lease dışında (`os.tmpdir()/orc-cbm-rt/<hash>`, manager.ts:152-166; validation.ts:22-26,78-81 kontrolü yalnız runner için tanımlıyor). Kod değişmedi, davranış local.test.ts'deki kilit testiyle sabitlendi. B-003 GERÇEK HATA: win32'de `isPathInside` (validation.ts:127) `\C:\...` UNC yolunu lease içinde sayıyordu (path.win32.relative baştaki ayırıcıları atıyor). Kırmızı test 2 FAIL → `sameRoot` kök kontrolü eklendi → tests/unit/sandbox 81/81, etkilenenler 67/67 + 47/47, typecheck yeşil. Açık konu: local.ts:1-3 yorumu bu farkı belgelemiyor. Daha dar local kısıt önerisi Opus'a soruldu.
- Dalga 1 kapıları (test-kosucu) tamam, hepsi YEŞİL (yukarıdaki not). Opus DALGA-KABUL (dalga 1) başlatıldı. Dalga 2 başlatıldı: Mimari B-001 sözleşme (SendMessage), Worker local.ts yorumu (SendMessage), QA B-005 (yeni ajan, opus), Platform B-006(b) (yeni ajan, sonnet). QA B-006 test tarafı (c + ORC_REQUIRE_CBM + .gitkeep) 4 ajan sınırı nedeniyle sırada.
- Dalga 2: Worker local.ts:1-5 başlık yorumunu düzeltti (yalnız yorum değişti); eslint temiz, local.test.ts 3/3 geçti. B-002 DOĞRULANDI. Sıradaki QA görevi (B-006 test tarafı + B-008 kalanı) SendMessage ile başlatıldı.
- Dalga 1 KABUL → B-003, B-004 ve B-007 KAPANDI. B-002 kod değişikliği (kilit testi) kabul edildi; yorum düzeltmesi dalga 2 kabulünde. Taban yalnız dalga 1 dosyalarıyla ilerletildi (git add, 13 dosya). Dalga 2 dosyaları hariç tutuldu.
- Dalga 2: Mimari B-001'i uyguladı. contract.md 2.2.1: changelog (satır 13-18), §10.3'e atıf (2329), §10.11 m.5'e CBM_RUNTIME_DIR (2467). Ret kodu env_rejected, lease-manager.test.ts:320-328 ile uyumlu. prompt.test.ts 17/17 geçti. Lint'teki tek kırmızı scripts/test-linux.mjs:39 (`CBM_IMAGE` kullanılmıyor); Platform'un yarım kalan işi, Platform kabul kriterinde lint var.
- Dalga 2: QA B-006 test tarafı tamam. test-setup.test.ts ve dependency-rules.test.ts'te skipIf kaldırıldı; dependency-rules'ta ek olarak "PENDING boş olmalı" assert'i getirildi (sıkılaştırma, Opus kabulünde değerlendirilecek). mcp-real.test.ts ve cbm-anchor.test.ts ORC_REQUIRE_CBM=1 iken ikili yoksa FAIL veriyor; mantık tests/helpers/mcp/support.ts'te (isCbmRequired, Zod). 7 .gitkeep silindi (tests/* ve docs/security) → B-008 tamam. Normal koşu: 116 geçti / 5 atlandı. ORC_REQUIRE_CBM=1 ile beklenen kırmızı gösterildi. typecheck ve lint yeşil. cbm-anchor'ın FAIL yolu yalnız test:linux'ta doğrulanabilir.
- Dalga 2: Platform B-006(b) tamam. scripts/test-linux.mjs: CBM_VERSION Dockerfile ARG'ından okunuyor, `--target cbm` → COPY --from yapılıyor, imaj etiketi `orc-test-linux:24.18.0-git-cbm0.12.0`, konteynere CODEBASE_MEMORY_MCP_BIN ve ORC_REQUIRE_CBM=1 geçiyor, mcp-real DEFAULT_TARGETS'a eklendi. docs/operations/troubleshooting.md'ye amd64 notu eklendi. Hedefli test:linux: 2 dosya geçti, 7 test geçti / 2 atlandı (ikili-yok ve Windows'a özgü koşullu testler; gerçek ikili testleri koşuldu). Lint temiz. Risk: ilk imaj ağ indirmesi gerektiriyor, arm64 desteklenmiyor.
- Dalga 2: QA B-005 (opus) tamam. Yeni dosyalar: tests/setup/{global-teardown,leak-ledger,process-table,leak-db,leak-worker,leak-worker-record}.ts, tests/helpers/common/leak-fixtures.ts, tests/integration/leak-detection.test.ts, tests/README.md. Değişenler: vitest.config.ts (infra projelerine globalSetup [GLOBAL_INFRA, global-teardown] ve setupFiles leak-worker) ve test-config.test.ts. Opus K3 koşulları 1-6 dosya:satır kanıtıyla uygulandı. Windows CIM gerçek koşuda çalıştı (~2 s). leak-detection 9/9, test-config 40/40, api 77/77 ve security 252/252 geçti; rapor her koşuda clean. typecheck ve lint yeşil. Rapor tests/reports/leaks.json'a yazılıyor (gitignore:25).
  - Riskler: Vitest'in deneysel state API'sine bağımlılık; iki snapshot arasında başka bir koşunun bıraktığı dizin yanlış atfedilebilir (REAP başka vitest koşusu varken yalnız uyarı veriyor); `orc-gm-int-` ve `orc-wk-` önekleri kapsam dışı.
  - Kapsam dışı notlar: test-linux.mjs, ORC_TEST_REAP ve ORC_TEST_LEAK_STRICT değişkenlerini konteynere geçirmiyor (Platform). Helper önekleri `orc-test-` altında birleştirilebilir (QA).
- Dalga 2'nin tüm ajanları tamam. Opus DALGA-KABUL (dalga 2) ve test-kosucu tam koşusu (K1–K4 + test:linux) paralel başlatıldı.
- Tam koşu: test:linux dışında hepsi YEŞİL. test:linux'ta 2 FAIL → B-012 (P1) açıldı. Çok takımı ilgilendirdiği için Worker ajanına opus modeliyle verildi (teşhis + düzeltme). Opus dalga 2 KABUL'ü test:linux yeşile dönene kadar bekletiliyor.
- Dalga 3: B-011 düzeltmesi ve B-009 kapsam çıkarımı QA (opus) ajanına SendMessage ile verildi. B-009 ve B-010, B-012 bitene kadar uygulanmayacak (test-linux.mjs ve worker testleriyle çakışma riski).
- B-011 tamam: öldürme mantığı `killVerifiedProcesses` (leak-ledger.ts:729) olarak ortaklaştırıldı; leak-fixtures cleanup bu fonksiyonu kullanıyor (PID ve başlangıç zamanı doğrulanıyor). leak-detection 3 ardışık koşuda 9/9 ve clean, test-config 40/40, typecheck ve lint yeşil.
- B-009 kapsamı: 22 farklı `orc-test-` dışı önek. 6 helper ve 15 test dosyası, 5 takım. A seçeneği (önekleri birleştirmek) yaklaşık 21 dosyaya dokunur; ayrıca `oca-` ve `orc-c-` önekleri soket yolu sınırı için bilerek kısa tutulmuş. QA'nın önerisi B: guard'a açıkça yazılmış tam önek listesi + mkdtemp 6 karakter son eki kuralı (`orc-cbm-rt` ve `orc-test-home` dışarıda kalır) + listeyi kodla senkron tutan unit test. Yalnız leak-ledger.ts ve test-config.test.ts değişir. Opus tasarım onayı B-012 kararıyla birlikte istenecek.
- B-012 teşhisi (Worker, opus): iki ayrı kök neden. (1) config.test.ts eski test hatası → B-013 (Mimari, test verisi). (2) pipeline dalga 2 regresyonu, kök neden manager.ts:165 → B-014 (P1 güvenlik, tasarım). Worker test-linux.mjs'te uid 1000 koşusuna ayrı TMPDIR verdi; worker koşusu 18/18 yeşil. Loglar scratchpad/b012-*.log. B-013 Mimari'ye verildi; B-014 ve B-009 tasarımları Opus'a sunuldu.
- Dalga 3: B-014 (code-intelligence, opus) ve B-009 (QA, sonnet, yeni ajan) başlatıldı. Sırada: B-014 bitince Platform test-linux.mjs'te /tmp/w ayrımını kaldıracak ve B-010'u (REAP/STRICT geçirme) yapacak; Mimari §10.11 local metnini güncelleyecek.
- B-013 tamam (Mimari): config.test.ts'te prod CBM_CACHE_DIR=/var/lib/orc/cbm-cache (docker-compose.yml:54) ve yeni 27 B ret testi (win32 dışında). Windows 34 geçti / 1 atlandı, Linux 35/35. typecheck temiz. Mimari'ye B-014'ün §10.11 local metni ve changelog'u verildi (SendMessage).
- B-014 sözleşme kısmı tamam (Mimari): contract.md:17 changelog'a eklendi; :2467 local yol POSIX'te `orc-cbm-rt-<uid>/<16 hex>` oldu ve lstat fail-closed kuralı yazıldı. Sürüm 2.2.1'de kaldı. lint yeşil, prompt.test 17/17.
- B-009 tamam (QA, sonnet): leak-ledger.ts'e LEAK_DIR_PREFIXES eklendi (24 açık önek, önek + 6 alfanümerik kuralı). Yeni tests/unit/architecture/test-prefixes.test.ts senkron taraması 8 gerekçeli istisna içeriyor; değişkenle kurulan önekte FAIL veriyor. Kırmızı kanıt: orc-wk- listeden çıkarılınca FAIL. leak-detection'a orc-wk- reap ve orc-cbm-rt taklidi vakaları eklendi. 245 test ve api 77/77 geçti, typecheck temiz. lint kırmızısı yalnız manager.test.ts'te (B-014'ün yarım kalan işi); ajana hatırlatıldı. Riskler: tanınmayan helper sarmalayıcısı taranmaz; orc-helper-* istisnada.
- B-014 tamam (Code Intelligence, opus): manager.ts: processUid :105, ebeveyn :109-110, assertPrivateDir :120-131 (PathEscapeError path_escape → mcp_unavailable), prepareLocalRuntimeDir :210-218, removeLocalRuntimeDir sahiplik kontrolü :220-232, prepareDirs :264-266 üç spawn yolunda çağrılıyor (:366, :404, :623). manager.test.ts: 4 vaka it.each (:276), mutlu yol (:304), soket bütçesi (:331, 91 B), kararlı yol sıkılaştırıldı (:193-203). Kırmızı 7 → yeşil 72/72. tsc ve eslint (tüm repo) exit 0. Linux hedefli koşu: root 69 geçti/1 atlandı, uid 1000 pipeline 6/6. Riskler: TOCTOU sticky-bit varsayımına dayanıyor; reuse yolu → B-015.
- Sırada: Platform /tmp/w'yi kaldıracak ve B-010'u yapacak; Mimari §10.11 metnine hata kodu ve soket bütçesini ekleyecek (ikisi de SendMessage ile).
- Mimari §10.11 local metnini uygulamayla hizaladı (contract.md:2467; path_escape, soket bütçesi tmpdir ≤ 20 B, win32 %TEMP% notu). lint yeşil. Not: `mcp_unavailable` kaydı koddan doğrulanmadı, Opus kabulünde kontrol ettirilecek.
- Platform: test-linux.mjs'ten /tmp/w ayrımı kaldırıldı. B-010 için flagEnv eklendi (ORC_TEST_REAP ve ORC_TEST_LEAK_STRICT yalnız 0/1, tanımsızsa geçirilmiyor). Paylaşılan /tmp hedefli koşusu: mcp-real 4 geçti/1 atlandı, pipeline 6/6, exit 0; STRICT=1 ile de exit 0. lint temiz.
- Dalga 3 tamam. Faz 5 başladı: test-kosucu tam koşu (K1–K4 + test:linux) ve opus-danisman dalga 3 kabulü paralel.
- Faz 5 son tam koşu (D2-F5-FULL2): 11 kapının 11'i YEŞİL, test:linux dahil. Dalga 2 ve dalga 3 kabulleri kesinleşti. B-001, B-002, B-005, B-006, B-008…B-014 KAPANDI. Taban `git add -A` ile ilerletildi. Açık kalanlar: B-015 (P2, ERTELENDİ, sonraki çağrının ilk kaydı) ve B-016 (P3). Döngü 2 KAPANDI.
- Döngü 3 başladı (2026-11-05). Kullanıcı isteği: abonelikle çalışma. Kullanıcı kararları: setup-token, iki auth modu da desteklenecek. Faz 1: Worker (opus) kurulu CLI 2.1.318 üzerinde deney yapacak; OAuth token'ın non-bare modda okunması ve izolasyon kanıtlanacak. Ürün kodu değişmeyecek.
- B-015 tasarımı hazır (.claude/state/tasarim/B-015.md). Çağrı noktası pipeline.ts:582 (claudeMcpConfig'in tek çağıranı); yeni mcpRuntimeStage indexStage'den sonra (:362-364) çalışacak. MCP_REQUIRED (shared/config.ts:410) görev başına genişliyor → ADR gerekiyor. Opus'a sorulacak açık nokta: requireIndex de fail-closed'ı tetiklesin mi? Çakışma riski B-017 ile (pipeline.ts buildRequest :789-866, apps/worker/src/config.ts:88-98) → sıra: önce B-017, sonra B-015. ADR numaraları: B-017 → ADR-0036, B-015 → ADR-0037.
- B-017 deneyi tamam (.claude/state/tasarim/B-017-deney.md; Win 2.1.318 ve Linux 2.1.316 aynı sonucu verdi).
  - (a) Non-bare + CLAUDE_CODE_OAUTH_TOKEN okunuyor (401 invalid; Bearer + oauth beta header). --bare ve SIMPLE=1 ile 'Not logged in'. Token ile birlikte verilen API anahtarı OAuth'u eziyor.
  - (b) Mevcut bayraklarla (--setting-sources user + --strict-mcp-config) zararlı repo içeriğinin hiçbiri çalışmadı; kaynaklar açılınca hook'lar çalıştı (negatif kontrol). ADR-0016'nın user-scope MCP gerekçesi bu sürümlerde geçerli değil.
  - (c) Kapatma anahtarları doğrulandı: disableAllHooks, autoMemoryEnabled:false / CLAUDE_CODE_DISABLE_AUTO_MEMORY, CLAUDE_CODE_DISABLE_CLAUDE_MDS, attribution boş, includeGitInstructions:false. LSP ve prefetch için anahtar yok.
  - Yeni bulgular: B-018, B-019, B-020. Tasarım (ADR-0036) Mimari'ye opus modeliyle verildi.
- B-017 tasarımı hazır (Mimari, opus): docs/adr/0036-claude-subscription-oauth-auth.md (Proposed; ADR-0016'yı supersede, ADR-0024'ü amend ediyor) ve .claude/state/tasarim/B-017.md.
  - Auth: CLAUDE_AUTH_MODE=oauth|api_key (varsayılan oauth). İkisi birden verilirse 5 katmanda ret. CLAUDE_BARE kaldırılıyor.
  - Argv: iki mod için tek non-bare hardened dizi (B-019'u kapatıyor). Token POSIX'te fd 3 ile, Windows'ta env ile.
  - validateInit sıkılaşıyor. B-020: APPDATA ve LOCALAPPDATA izole ediliyor.
  - Sözleşme 3.0.0 (MAJOR) → kullanıcı onayı gerekiyor.
  - Dalga planı: D0 deney → D1 (shared, security, fake-claude) → D2 (runner+worker, sandbox+orchestrator, compose+scripts+docs, QA helpers) → D3 (security docs ve testleri). Ardından kullanıcı onayıyla claude-live.
  - Açık deneyler: D-1, D-2, D-4, D-6 (Accepted için şart); B-018 API anahtarı modunda kalıntı risk olarak kalıyor (D-3).
- B-015 ve B-017 tasarımları Opus'a sunuldu.
- Opus K8/K9 kararları alındı. D0 deneyleri (D-1, D-2, D-4, D-6) deney ajanına SendMessage ile verildi. Kullanıcıya soruldu: sözleşme 3.0.0, D-7(a) için gerçek token, B-021.
- Kullanıcı kararları (2026-11-05): sözleşme 3.0.0 ONAYLANDI; secrets/README.md geri yüklendi (B-021 KAPANDI).
- D0 deneyleri (.claude/state/tasarim/B-017-D0.md):
  - D-1a/b/c GEÇ: fd 3 yolunda 3 istek de Bearer + oauth beta taşıdı. Bash'te fd 3 yok, /proc/<claude>/mem EACCES, ptrace_scope=1, resume ve fork çalıştı.
  - D-2 GEÇ: prlimit + setuid yolu çalıştı; log ölçütü Dalga 2'de doğrulanacak.
  - D-4 GEÇ: --restricted alınacak.
  - D-6 GEÇ ama rafine gerekiyor: oauth `schedule` skill'ini ekliyor, plugin kümesi platforma göre değişiyor → allowlist (sürüm, platform, mod) matrisine dönüşüyor.
  - D-3: MCP için mcp.json env override'ı kanıtlı, Bash için yol yok.
  - Mimari ADR-0036'yı revize ediyor. Dalga 1, D-7(a) (kullanıcının gerçek token biçim kontrolü) sonucunu bekliyor.
- ADR-0036 Accepted (D-7(a) bekliyor). D5 CLAUDE_REVIEWED_EXTENSIONS tablosu (<cliVersion>/<platform>/<authMode>); D8 logger redaksiyonu, D9 ptrace_scope (prod'da <1 ise runner sağlıksız), D10 auth hataları eklendi. Dalga planı: D1 Mimari (contract 3.0.0, ADR-0037, shared) + Security (env.ts) + QA (fake-claude). D2 Worker A (claude-runner, apps/worker) + Worker B (sandbox, runner ptrace, orchestrator AppData, auth-failure testi) + Platform (compose, scripts, logger, docs/ops, README) + QA (helpers, claude-live). D3 Code Intelligence (B-015, claudeEnvScrub) + Worker (orchestrator types/pipeline, worker config, mcp===null testi) + Security (docs, known-issues B-016/B-020) + Security testleri.

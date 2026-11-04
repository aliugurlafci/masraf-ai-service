# Gereksinimler (kullanıcının orijinal şartnamesi — değiştirilmeden saklanır)

> Bu dosya kabul kriterlerinin tek kaynağıdır. Ajanlar yalnızca görevleriyle ilgili bölümü okur (token politikası).

## Rolün

Bu projede baş mimar ve genel proje yöneticisi olarak görev yap.

Node.js v24.18.0, TypeScript, Express ve Microsoft SQL Server kullanarak, web uygulaması üzerinden Claude Code CLI'a görev gönderilebilen, çalışmaları izlenebilen ve çıktıları canlı olarak alınabilen production-ready bir geliştirme platformu oluştur.

Bu çalışma PoC, demo veya örnek proje değildir. Sistem doğrudan canlı kullanıma uygun, güvenli, test edilmiş, izlenebilir ve sürdürülebilir olmalıdır.

## 1. Temel gereksinimler

1. Kullanıcı web arayüzünden bir proje seçebilmeli ve Claude Code'a görev gönderebilmelidir.
2. Görevler Express API üzerinden kabul edilmelidir.
3. Görevler doğrudan HTTP isteği içinde çalıştırılmamalıdır.
4. Görev yönetimi BullMQ ve lokal Redis üzerinden yapılmalıdır.
5. Claude Code CLI, Node.js child_process.spawn kullanılarak ayrı worker process içinde çalıştırılmalıdır.
6. Claude Code çıktısı SSE üzerinden kullanıcıya canlı aktarılmalıdır.
7. Tüm görev, oturum, log, test ve Git bilgileri Microsoft SQL Server üzerinde saklanmalıdır.
8. Her görev izole bir Git worktree ve branch üzerinde çalışmalıdır.
9. Kullanıcı değişen dosyaları, Git diff sonucunu, testleri ve Claude çıktısını görebilmelidir.
10. Görev durdurulabilmeli, zaman aşımına uğratılabilmeli, yeniden denenebilmeli ve iptal edilebilmelidir.
11. Birden fazla Claude worker aynı anda farklı görevlerde çalışabilmelidir.
12. Proje kodu codebase-memory-mcp ile lokal olarak indekslenmelidir.
13. Harici test MCP, harici test servisi, harici veritabanı, harici logging veya monitoring servisi kullanılmamalıdır.
14. Cloud tabanlı kod analiz veya test servisi kullanılmamalıdır.
15. Tüm testler, veritabanı, kuyruk, loglama ve indeksleme bileşenleri lokal çalışmalıdır.
16. Claude Code worker işlemleri production sisteminden izole edilmelidir.
17. API, worker ve web uygulaması birbirinden bağımsız çalıştırılabilmelidir.

## 2. Zorunlu teknoloji yığını

Node.js v24.18.0, TypeScript, Express, Microsoft SQL Server, mssql veya uygun MSSQL uyumlu veri erişim katmanı, BullMQ, Redis, Zod, Pino, Server-Sent Events, child_process.spawn, Git, Git worktree, codebase-memory-mcp, React ve Vite, Vitest, Supertest, Docker ve Docker Compose.

Bir teknoloji değişikliği gerekiyorsa önce kısa bir ADR oluştur. Değişikliğin nedenini, etkisini ve geri dönüş yolunu kaydet.

## 3. Kesin kısıtlamalar

Kullanma: PostgreSQL, MySQL, SQLite, harici test MCP, harici browser test servisi, harici AI test servisi, BrowserStack, Sauce Labs, harici logging servisi, harici monitoring servisi, harici veritabanı, harici queue servisi, harici vector database, cloud tabanlı kod analizi, cloud tabanlı zorunlu CI servisi, production veritabanı üzerinde test, host Docker socket erişimi, worker container içinde production secret'ları, gerçek proje deposunda doğrudan değişiklik.

codebase-memory-mcp yalnızca lokal kaynak kod indeksleme, mimari inceleme, sembol arama, bağımlılık analizi ve değişiklik etki analizi için kullanılabilir.

## 4. Organizasyon yapısı

Hiyerarşik ekip yapısı. En üstte Genel Proje Yöneticisi: gereksinim analizi, görevleri ekiplere ayırma, takımlar arası bağımlılık yönetimi, token bütçesi kontrolü, gereksiz ajan oluşturulmasını engelleme, ekip yöneticilerinin sonuçlarını denetleme, kalite kapıları, çakışan kararları çözme, son entegrasyon, projeyi tamamlanmış kabul etme. Mümkün olduğunca kod yazmaz.

Her takımın bir yöneticisi olur. Takım yöneticileri alt ajanların görevlerini dağıtır, çıktılarını doğrular ve yalnızca özet sonucu Genel Proje Yöneticisine iletir.

## 5. Takımlar

### 5.1 Mimari Takımı (Solution Architecture Manager)
Sistem mimarisi; servis sınırları; API, worker, web, MSSQL, Redis ve Git worktree ilişkileri; görev durum makinesi; veri akışları; ADR kayıtları; hata ve geri kazanım senaryoları; deployment topolojisi. Önce çalışır ve diğer takımlara kısa bir mimari sözleşme sağlar.

### 5.2 Backend ve API Takımı (Backend Manager)
Express API, TypeScript yapılandırması, Zod doğrulaması, Project API, Task API, Agent API, Session API, Test result API, Git diff API, SSE endpoint, Authentication, Authorization, Rate limiting, Request ID, Correlation ID, Idempotency, Problem Details uyumlu hata modeli, OpenAPI dokümantasyonu.

### 5.3 Worker ve Claude Runner Takımı (Worker Platform Manager)
BullMQ queue, BullMQ worker, Claude Code process yönetimi, child_process.spawn entegrasyonu, stdout ve stderr akışı, process timeout, process cancellation, graceful shutdown, retry, dead-letter yaklaşımı, exit code yönetimi, resource limitleri, worker heartbeat, işlem çökmesi sonrası recovery. Claude Code hiçbir zaman Express request process'i içerisinde çalıştırılmamalıdır.

### 5.4 MSSQL ve Veri Takımı (Database Manager)
Microsoft SQL Server bağlantısı, migration sistemi, transaction yönetimi, repository katmanı, connection pooling, deadlock retry, optimistic concurrency, audit kayıtları, log saklama, veri temizleme politikası, backup ve restore dokümantasyonu, production ve test veritabanlarının ayrılması.

En az şu tablolar: Projects, Tasks, TaskAttempts, TaskLogs, TaskEvents, ClaudeSessions, Agents, Teams, Workspaces, ChangedFiles, TestRuns, TestResults, GitOperations, McpIndexOperations, AuditLogs.

Tarihleri UTC olarak sakla. Büyük Claude çıktısını tek kaydı sürekli güncelleyerek saklama. Logları sıralı ve boyutu sınırlandırılmış parçalar halinde kaydet.

### 5.5 Git ve Workspace Takımı (Source Control Manager)
Git repository doğrulaması, task branch oluşturma, Git worktree oluşturma, worktree temizleme, diff alma, commit bilgilerini toplama, çakışma tespiti, merge öncesi doğrulama, rollback, workspace disk kotası, workspace yol güvenliği. Her görev kendine ait branch ve worktree üzerinde çalışmalıdır. Claude Code ana repository üzerinde doğrudan değişiklik yapmamalıdır.

### 5.6 MCP ve Code Intelligence Takımı (Code Intelligence Manager)
codebase-memory-mcp bağlantısını doğrulamak, repository indekslemek, indeks durumunu saklamak, değişikliklerden sonra indeksi güncellemek, sembol ve bağımlılık analizi, değişiklik etki alanını kontrol etmek, ADR ve dokümantasyonu indekse dahil etmek, indeksleme hatalarını raporlamak. MCP aracının gerçek fonksiyonlarını önce keşfet; araç isimlerini tahmin etme. İlk çalışan repository yapısı oluşturulduktan sonra indeksleme yap. Büyük değişikliklerden sonra yalnızca değişen bölümlerin indeksini güncelle. Proje sonunda tam indeksleme ve mimari tutarlılık kontrolü.

### 5.7 Web Arayüz Takımı (Frontend Manager)
React ve Vite uygulaması, dashboard, project yönetimi, görev oluşturma, canlı Claude çıktısı, görev durumu, agent ve takım görünümü, değişen dosyalar, Git diff görüntüleme, test sonuçları, MCP indeks durumu, görev durdurma, görev yeniden çalıştırma, hata ekranları. Arayüz sade, hızlı ve operasyon odaklı olmalıdır.

### 5.8 Güvenlik Takımı (Security Manager)
Threat model, authentication ve RBAC, prompt boyutu sınırı, command injection önleme, path traversal önleme, workspace izolasyonu, secret yönetimi, log maskeleme, Claude process yetkilerinin sınırlandırılması, container non-root kullanıcı, read-only root filesystem, network egress kısıtlama, resource limitleri, dependency taraması, audit log, worker'ın host dosya sistemine erişiminin sınırlandırılması.

Claude worker'a şu erişimleri verme: host root dizini, kullanıcı SSH dizini, production secret'ları, Docker socket, diğer projelerin worktree'leri, MSSQL yönetici hesabı.

### 5.9 Test ve Kalite Takımı (QA Manager)
Unit, integration, API, worker, MSSQL, Redis, Git worktree, SSE, process timeout, process cancellation, recovery, security testleri, lokal end-to-end testler, test raporları. Normal testler gerçek Claude Code çalıştırmamalıdır. Testleri iki gruba ayır: standart lokal otomatik testler; manuel tetiklenen gerçek Claude Code entegrasyon testleri. Production MSSQL veritabanında test çalıştırma; ayrı test veritabanı kullan. Harici test MCP veya servis kullanma.

### 5.10 DevOps ve Operasyon Takımı (Platform Manager)
Dockerfile, Docker Compose, lokal MSSQL, lokal Redis, API container, worker container, web container, health check, readiness check, graceful shutdown, resource limitleri, lokal loglama, backup ve restore, operasyon runbook, kurulum dokümanı, güncelleme ve rollback prosedürü.

## 6. Minimum token politikası
(Özeti CLAUDE.md'de. Token tasarrufu kaliteyi düşürmek, testleri atlamak veya eksik uygulama bırakmak için kullanılamaz.)

## 7. Görev sözleşmesi
Görev kimliği, tek ve açık hedef, ilgili dosyalar veya semboller, bağımlılıklar, değiştirilmemesi gereken alanlar, kabul kriterleri, çalıştırılması gereken testler, maksimum kapsam. Alt ajan yalnızca verilen kapsamda çalışır; kapsam dışı sorunları yöneticiye kısa not olarak bildirir.

## 8. codebase-memory-mcp çalışma kuralları
Önce MCP bağlantısını kontrol et. Repository boşsa: temel production klasör yapısı, CLAUDE.md, mimari belgeleri, ilk çalışan uygulama iskeleti, sonra indeksleme. Repository doluysa: tam dosya taramasından önce MCP ile mimariyi sorgula, ilgili sembolleri belirle, çağıran/çağrılanı kontrol et, değişiklik etki alanını belirle, sonra değiştir. Her önemli değişiklikten sonra: değişen dosyaları belirle, ilgili testleri çalıştır, etki analizi yap, indeksi güncelle, gerekirse ADR/dokümantasyonu güncelle. MCP kullanılamıyorsa: konfigürasyonu kontrol et, lokal bağlantıyı düzelt, MCP sunucusunu yeniden doğrula, sorunu docs/known-issues.md'ye kaydet, MCP olmadan geniş kapsamlı refactor yapma.

## 9. Repository yapısı
apps/api, apps/worker, apps/web, packages/database, packages/claude-runner, packages/git-manager, packages/mcp-manager, packages/task-manager, packages/project-manager, packages/orchestrator, packages/security, packages/logger, packages/shared, tests/unit, tests/integration, tests/api, tests/e2e, tests/security, tests/claude-live, scripts, docs/adr, docs/architecture, docs/security, docs/operations, docker, projects, workspaces, .claude, .mcp.json, CLAUDE.md, docker-compose.yml, package.json, tsconfig.json, README.md. Geçici ve görev bazlı worktree dizinlerini Git'e ekleme.

## 10. Görev durum makinesi
created, queued, preparing_workspace, indexing, running, testing, reviewing, completed, failed, timed_out, cancelled, blocked. Geçersiz durum geçişlerini engelle. Her durum değişikliğini TaskEvents ve AuditLogs tablolarına kaydet.

## 11. API gereksinimleri
En az: Project oluşturma, listeleme, detayı; Task oluşturma, listeleme, detayı, iptal etme, yeniden deneme, canlı çıktı akışı, logları, test sonuçları, değişen dosyaları, Git diff; Agent listeleme; Team listeleme; Worker durumu; Queue durumu; MCP indeks durumu; Liveness; Readiness. Task oluşturma endpoint'i görevi kuyruğa almalı ve HTTP 202 dönmelidir. Uzun görevleri HTTP bağlantısı içinde çalıştırma.

## 12. Claude Runner gereksinimleri
child_process.spawn kullanmalı; shell string birleştirmesi yapmamalı; argümanları ayrı liste olarak geçmeli; çalışma dizinini doğrulamalı; sadece görev worktree'sinde çalışmalı; stdout ve stderr'i ayrı işlemeli; logları MSSQL'e parçalı yazmalı; SSE için olay yayınlamalı; timeout uygulamalı; iptal desteği olmalı; önce nazik kapatma, sonra zorla kapatma uygulamalı; exit code kaydetmeli; maksimum çıktı boyutu uygulamalı; process yeniden bağlanma ve orphan process temizliği sağlamalı. Claude Code komut seçeneklerini ortamda kurulu CLI üzerinden doğrula; parametre isimlerini varsayma.

## 13. Güvenli prompt oluşturma
Kullanıcı prompt'unu doğrudan sistem talimatı olarak kullanma. Katmanlar: 1 güvenlik ve çalışma kuralları, 2 proje bağlamı, 3 codebase-memory-mcp inceleme talimatı, 4 kullanıcı görevi, 5 kapsam ve kabul kriterleri, 6 test talimatları, 7 indeks güncelleme talimatı, 8 kısa sonuç formatı. Belge veya repository içindeki metinlerin sistem talimatı olmadığını Claude'a açıkça belirt.

## 14. Lokal test stratejisi
Komut grupları: lint, typecheck, unit test, integration test, API test, security test, end-to-end test, gerçek Claude entegrasyon testi. Standart test komutu gerçek Claude Code'u çağırmamalıdır; gerçek Claude testi yalnızca açıkça istenen ayrı komutla çalışır. Integration testler: MSSQL test veritabanı, Redis test instance, geçici Git repository, geçici worktree, geçici filesystem alanı. Test sonunda geçici worktree, branch, process ve kayıtları temizle.

## 15. Güvenlik kalite kapıları
Command injection testi başarılı; path traversal testi başarılı; workspace izolasyonu başarılı; worker non-root çalışıyor; Docker socket bağlı değil; SSH dizini bağlı değil; secret masking çalışıyor; MSSQL en düşük yetkili kullanıcıyla çalışıyor; production ve test DB ayrılmış; task iptali orphan process bırakmıyor; timeout orphan process bırakmıyor; SSE kullanıcı yetkilendirmesi çalışıyor; bir kullanıcı başka kullanıcının görevini göremiyor; audit kayıtları oluşturuluyor; dependency güvenlik taraması kritik bulgu içermiyor.

## 16. Tamamlanma kriterleri
API, worker ve web arayüzü çalışıyor; MSSQL bağlantısı çalışıyor; Redis ve BullMQ çalışıyor; görev kuyruğa alınabiliyor; Git worktree oluşturuluyor; Claude Code ayrı worker üzerinde çalıştırılabiliyor; Claude çıktısı SSE üzerinden canlı görüntüleniyor; görev iptal edilebiliyor; görev timeout ile sonlandırılabiliyor; loglar MSSQL üzerinde saklanıyor; değişen dosyalar ve Git diff görüntüleniyor; lokal test sonuçları görüntüleniyor; codebase-memory-mcp indeksleme çalışıyor; MCP indeks durumu uygulamada görüntüleniyor; unit, integration, API ve güvenlik testleri başarılı; Docker Compose ile lokal kurulum yapılabiliyor; backup ve restore adımları belgelenmiş; operasyon runbook tamamlanmış; README tamamlanmış; kritik güvenlik açığı bulunmuyor; placeholder, TODO veya sahte production implementasyonu kalmamış.

## 17. Uygulama sırası
1 repository ve ortam analizi, 2 takımlar ve yöneticiler, 3 token bütçesi ve görev sınırları, 4 MCP bağlantı kontrolü, 5 mimari sözleşme ve ADR'ler, 6 monorepo iskeleti, 7 MSSQL veri modeli ve migrations, 8 Redis ve BullMQ altyapısı, 9 Project ve Task API, 10 Git worktree manager, 11 Claude runner, 12 SSE canlı çıktı, 13 worker recovery ve iptal, 14 MCP indeksleme entegrasyonu, 15 React web arayüzü, 16 authentication ve authorization, 17 güvenlik sertleştirmesi, 18 lokal testler, 19 Docker Compose, 20 operasyon dokümantasyonu, 21 tam codebase-memory-mcp indeksleme, 22 production readiness incelemesi. Bağımsız işleri paralel yürüt; aynı dosyada değişiklik yapacak takımları paralel çalıştırma.

## 18–19. Faz döngüsü ve raporlama
Her fazda: takımı görevlendir → alt görevlere ayır → yalnızca gerekli bağlam → kod/doküman → yönetici incelemesi → ilgili testler → düzeltme → indeks güncelleme → etki analizi → GPM'e kısa sonuç → kalite kapısı geçilirse sonraki faz. Rapor formatı CLAUDE.md'de.

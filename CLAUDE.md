# Claude Code Orchestrator — ortak kurallar

Bu dosya tüm ajanlar için TEK ortak kural kaynağıdır. Burada yazanı görev sözleşmelerinde tekrar etme; yalnızca ilgili kurala atıf yap.

## Ürün

Web arayüzünden proje seçilip Claude Code CLI'a görev gönderilen, görevlerin BullMQ/Redis ile kuyruklandığı, Claude Code'un ayrı worker process'te `child_process.spawn` ile izole Git worktree üzerinde çalıştığı, çıktının SSE ile canlı aktarıldığı ve tüm verinin Microsoft SQL Server'da saklandığı production-ready platform. PoC değildir.

Bağlayıcı teknik sözleşme: `docs/architecture/contract.md`. Sözleşmeye aykırı arayüz değişikliği yapma; gerekiyorsa önce `docs/adr/` altında kısa ADR yaz (neden, etki, geri dönüş yolu) ve Genel Proje Yöneticisine bildir.

## Organizasyon ve sahiplik

Genel Proje Yöneticisi (GPM): ana oturum. Koordinasyon, bağımlılık, token bütçesi, kalite kapısı, kabul. Mümkün olduğunca kod yazmaz.

| Takım | Yönetici | Sahip olduğu yollar |
|---|---|---|
| Mimari | Solution Architecture Manager | `docs/architecture`, `docs/adr`, `packages/shared` |
| Backend ve API | Backend Manager | `apps/api`, `packages/task-manager`, `packages/project-manager` |
| Worker ve Claude Runner | Worker Platform Manager | `apps/worker`, `apps/runner`, `packages/claude-runner`, `packages/orchestrator`, `packages/sandbox` |
| MSSQL ve Veri | Database Manager | `packages/database` |
| Git ve Workspace | Source Control Manager | `packages/git-manager` |
| MCP ve Code Intelligence | Code Intelligence Manager | `packages/mcp-manager` |
| Web Arayüz | Frontend Manager | `apps/web` |
| Güvenlik | Security Manager | `packages/security`, `docs/security`, `tests/security` |
| Test ve Kalite | QA Manager | `tests/*` altyapısı, `vitest.config.ts`, `tests/e2e`, `tests/api`, `tests/claude-live` |
| DevOps ve Operasyon | Platform Manager | `docker/`, `docker-compose*.yml`, `scripts/`, `docs/operations`, `apps/egress-proxy`, `packages/logger` |

Kural: Bir ajan yalnızca görev sözleşmesinde verilen yollarda dosya değiştirir. Kapsam dışı sorunu düzeltme; kısa not olarak raporla. Birim testleri sahibi olan takım `tests/unit/<paket>/` altında yazar.

## Minimum token politikası (zorunlu)

1. Aynı dosyayı gereksiz yere tekrar okuma; tam dosya yerine gereken sembol/satır aralığını oku.
2. Repository'yi taramak yerine önce codebase-memory-mcp ile hedefli sorgu yap (`search_graph`, `get_code_snippet`, `trace_path`).
3. Mimari açıklamayı tekrar etme; `docs/architecture/contract.md` ilgili bölümüne atıf yap.
4. Test/komut çıktısının tamamını bağlama alma; yalnızca hata bölümlerini incele (`--reporter=dot`, `| Select-Object -Last 40`, `tail`).
5. Başarılı komutların uzun çıktısını tekrar etme. Aynı hatayı aynı yöntemle ikinci kez analiz etme.
6. Gerekmedikçe yeni ajan oluşturma; tek ajanla güvenli yapılabilen işi bölme. Bağımsız işler paralel, bağımlı işler sıralı.
7. İndeksi her küçük değişiklikte tamamen yenileme; değişen bölüm için artımlı güncelleme yeterli.
8. Token tasarrufu; test atlamak, eksik uygulama veya placeholder bırakmak için gerekçe DEĞİLDİR.

## Model politikası (token optimizasyonu)

Takım varsayılanı `.claude/agents/*.md` `model:` alanındadır; GPM görevi atarken işin niteliğine göre `model`/`effort` ile override eder.

| Takım | Varsayılan | Gerekçe |
|---|---|---|
| Solution Architecture, Security | opus | Sözleşme/ADR kararları ve tehdit analizi tüm takımlara yayılır; hata maliyeti yüksek |
| Backend, Worker Platform, Database, Source Control, Code Intelligence, Frontend, QA, Platform | sonnet | Sözleşmesi belli uygulama ve test yazımı |
| `test-kosucu` (salt koşu) | haiku | Kapı koşma ve hata tablosu mekanik iş |
| `opus-danisman` (salt okuma) | opus | Tasarım onayı, takılan hata kararı, dalga kabulü; denetim döngüsü: `/takim-denetim` |

İş bazında override: mekanik doküman/eşleme güncellemesi, dosya varlık kontrolü, tablo/yol düzeltmesi → `haiku`; yeni test/özellik (sözleşme hazır) → `sonnet`; eşzamanlılık, kurtarma, süreç ağacı/sandbox, güvenlik açığı düzeltmesi veya sözleşme sapması kararı → `opus`. Salt okuma keşif → `codebase-memory-scout` + `effort: lower`.

## Görev sözleşmesi (yönetici → alt ajan)

Görev kimliği · Tek ve açık hedef · İlgili dosya/semboller · Bağımlılıklar · Değiştirilmeyecek alanlar · Kabul kriterleri · Çalıştırılacak testler · Maksimum kapsam.

## Rapor formatı

Alt ajan → yönetici: tamamlanan iş · değişen dosyalar · test sonucu · risk/engel.
Yönetici → GPM: Durum · Tamamlanan görevler · Değişen dosyalar · Test sonucu · Açık riskler · Sonraki bağımlılık.
Uzun düşünce zinciri veya tam komut çıktısı raporlanmaz.

## Mühendislik kuralları

- Node.js v24.18.0, TypeScript strict, ESM. `any` yok (gerekirse `unknown` + Zod). Placeholder/TODO/sahte implementasyon yok.
- Tüm dış girdi (HTTP, env, queue job, Claude stream-json, MCP yanıtı) Zod ile doğrulanır.
- Process çalıştırma: yalnızca `child_process.spawn(cmd, argsArray, { shell: false })`. Shell string birleştirme yasak. Çocuk process'e yalnızca izinli ortam değişkenleri geçer.
- SQL: yalnızca parametreli sorgu (`mssql` input binding). String birleştirmeyle SQL yasak. Tüm tarihler UTC (`DATETIME2(3)`, `SYSUTCDATETIME()`).
- Dosya yolları: kullanıcı/DB kaynaklı her yol `@orc/security` `resolveWithin` ile kök dizine sabitlenir.
- Log: `@orc/logger` (Pino). Secret'lar maskelenir. `console.log` yasak (CLI script'leri hariç).
- Standart testler gerçek Claude Code çağırmaz (sahte CLI: `tests/fixtures/fake-claude`). Gerçek Claude testi yalnızca `npm run test:claude-live`.
- Testler yalnızca test veritabanına (adı `_test` ile biter, ayrı container) bağlanır; production DB'de test çalıştırılmaz.
- Yasak: PostgreSQL, MySQL, SQLite, harici test/logging/monitoring/queue/vector/DB servisleri, cloud kod analizi, Docker socket erişimi, worker'da production secret'ları, gerçek proje deposunda doğrudan değişiklik.
- Git commit/push yalnızca kullanıcı isterse.

## codebase-memory-mcp

Gerçek araç adları (v0.12.0, doğrulandı): `index_repository`, `index_status`, `list_projects`, `delete_project`, `detect_changes`, `search_graph`, `search_code`, `query_graph`, `trace_path`, `get_code_snippet`, `get_file_outline`, `get_graph_schema`, `get_architecture`, `check_index_coverage`, `compare_graphs`, `manage_adr`, `ingest_traces`. Tahmini araç adı kullanma.

Bu repository'nin indeks projesi: `C-Workout-masraf-ai-service`. Değişiklikten önce: mimariyi/sembolü sorgula → çağıran/çağrılanı kontrol et → etki alanını belirle → değiştir. Değişiklikten sonra: ilgili testleri çalıştır → `detect_changes` ile etki analizi → indeks artımlı güncellenir. MCP kullanılamıyorsa sorunu `docs/known-issues.md`'ye yaz ve MCP olmadan geniş refactor yapma. MCP oturumu koptuysa aynı gerçek araçları yerel CLI ile çağır (KI-001): Git Bash'te `codebase-memory-mcp cli --quiet search_graph '{"project":"C-Workout-masraf-ai-service","name_pattern":"X"}'`.

Sözleşme (`docs/architecture/contract.md`, ~300 KB) asla bütünüyle okunmaz: `grep -n "^## \|^### " docs/architecture/contract.md` ile bölüm satırlarını bul, yalnızca görevindeki bölümleri `sed -n 'A,Bp'` ile oku.

## Komutlar

Komut listesi kök `package.json` script'lerindedir (`lint`, `typecheck`, `test`, `test:unit`, `test:integration`, `test:api`, `test:security`, `test:e2e`, `test:claude-live`, `infra:test:up`). Ayrıntı: `README.md`.

# B-017 deney: abonelik OAuth token'ı ile bare'siz runner (salt doğrulama, ürün kodu değişmedi)
CLI: Windows host 2.1.318, Linux `orc-worker:smoke` 2.1.316. Harness `spawn(claude, argv, {shell:false})` ile çalıştı; env sıfırdan kuruldu. HOME, USERPROFILE, APPDATA, LOCALAPPDATA, TMP ve CLAUDE_CONFIG_DIR her koşuda izole edildi. Yalnız sahte token kullanıldı (`sk-ant-oat01-INVALIDb017…`).
Kanıt üç kaynaktan geldi: gerçek API'nin hata metni, yerel sahte API (`ANTHROPIC_BASE_URL`; header'lar, gövdedeki kanaryalar ve `Glob` tool_use senaryosu) ve CONNECT'leri kaydedip reddeden proxy. İşaret dosyaları da tutuldu.
Taban argv §10.2 ile aynı: `-p --output-format stream-json --verbose --setting-sources user --permission-mode dontAsk --tools Read,Edit,Write,Glob,Grep,Bash --allowed-tools … --disallowed-tools … --mcp-config <cbm> --strict-mcp-config --append-system-prompt … --session-id …`.
Çalışma kökü `C:\Workout\_b017_tmp` oldu. Scratchpad kullanıcı profili altında; üst dizin CLAUDE.md taraması gerçek `~/.claude`'a ulaşmasın diye dışarı alındı. Kök deney sonunda silindi.

## (a) Auth: sahte token için gerçek API yanıtı ve yakalanan header
| # | Kombinasyon | Sonuç | Header (sahte API) |
|---|---|---|---|
| A0/A7 | kimlik yok (bare ya da değil) | "Not logged in · Please run /login" | istek yok |
| A1 | bare'siz + `CLAUDE_CODE_OAUTH_TOKEN` | **401 "OAuth access token is invalid"**, yani env okunuyor | `Authorization: Bearer oat` + `anthropic-beta: oauth-2025-04-20` |
| A2 | `--bare` + `CLAUDE_CODE_OAUTH_TOKEN` | Not logged in | istek yok |
| A3 | bare'siz + `CLAUDE_CODE_SIMPLE=1` + token | Not logged in (SIMPLE de OAuth'u kapatıyor) | istek yok |
| A4 | `--bare` + `--settings {apiKeyHelper → oat}` | apiKeySource=apiKeyHelper; 401, 8 retry, 90 sn sonra timeout | `x-api-key: oat` + `Bearer oat`, oauth beta yok |
| A5 | `--bare` + `ANTHROPIC_AUTH_TOKEN=oat` | 401 "OAuth … invalid" | Bearer var, oauth beta yok (gerçek token ile doğrulanamaz) |
| A6 | bare'siz + `ANTHROPIC_API_KEY` | "Invalid API key" | `x-api-key` |
| A8/A9 | `--safe-mode` + token / buna ek SIMPLE | 401 OAuth / Not logged in | Bearer + oauth beta |
| A10 | token ve `ANTHROPIC_API_KEY` birlikte | apiKeySource=ANTHROPIC_API_KEY | yalnız x-api-key; API key OAuth'u ezer |
| F1 | `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3` (pipe) | Linux'ta Bearer + oauth beta; Windows'ta Not logged in | — |
Sonuç: OAuth'u desteklenen yoldan kabul eden tek kombinasyon şu: `--bare` yok, SIMPLE yok, `CLAUDE_CODE_OAUTH_TOKEN` env'de (Linux'ta FD de olur). A4 ve A5 desteklenmeyen yollar, önerilmez.

## (b) İzolasyon, bare'siz (B1). Pozitif kontrol K9: `--setting-sources user,project,local`
- **B1'de engellendi:** proje ve local hook'lar (SessionStart, UserPromptSubmit, PreToolUse), statusLine, local apiKeyHelper, `.mcp.json` (+`enableAllProjectMcpServers`), proje plugin'i (enabledPlugins + directory marketplace, plugin hook/MCP/LSP/skill), skills/agents/commands, CLAUDE.md + `@import`, CLAUDE.local.md, üst dizin CLAUDE.md, `.claude/rules`. Yalnız izinli MCP başladı.
- **K9'da çalıştı:** proje hook'ları ×3, local hook ve local apiKeyHelper (auth'u ele geçirdi: apiKeySource=apiKeyHelper). Tüm CLAUDE.md kanaryaları gövdedeydi; xskill, xagent ve xcmd init'te göründü. `.mcp.json` ve plugin K9'da da yüklenmedi (strict mod; `-p` plugin kurmuyor).
- **B1'de açık kalan:** auto-memory (`memory_paths.auto`, MEMORY.md gövdede), user CLAUDE.md (CLAUDE_CONFIG_DIR, platform alanı), user-scope hook (K0'da 3 işaret), Co-Authored-By, LSP manager (0 sunucu), "background startup prefetches", ek bundled skill `schedule`.
- User-scope MCP (`.claude.json` + settings `mcpServers`) strict ile engelli (M1, iki platformda). ADR-0016'nın bu gerekçesi bu sürümlerde geçerli değil.
- **Init:** `hooks` alanı yok. mcp_servers=[codebase-memory-mcp connected]. 3 builtin plugin bare'de de var. skills 17 (bare 16), agents 5 builtin, tools 6+mcp, cwd doğru.
- Ürünün `validateInit`'i (tsx ile koşuldu) B1, K0, K9 ve H*'te ok=true döndü. Skills, agents, slash_commands, plugins ve memory_paths alanlarını denetlemiyor.
- Hook olayları: stream'de varsayılan olarak yalnız SessionStart olayı geliyor. UserPromptSubmit/PreToolUse yalnız `--include-hook-events` ile geliyor (K0i). `hook_event` kuralı yalnız bare'de uygulanıyor; bu yüzden K0 ve K9 yakalanmıyor.

## (c) Kapatma anahtarları (her biri ayrı koşuda doğrulandı, Win ve Linux)
| Özellik | Doğrulanan anahtar | Kanıt |
|---|---|---|
| hook (user/plugin) | `disableAllHooks:true` (user settings K1; `--settings` H1, flag user'ı ezer) | işaret yok. Builtin cc-plugin native hook'ları her modda yükleniyor, olay üretmiyor (H1i) |
| proje settings/hook/CLAUDE.md | `--setting-sources user` (mevcut) | B1 vs K9 |
| auto-memory | `autoMemoryEnabled:false` (K2) / env `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (K3) | memory_paths ve MEMORY kanaryası yok |
| CLAUDE.md (user dahil) | env `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` (K4; memory_paths kalıyor) / `claudeMdExcludes` (K5) | USERMD yok |
| attribution | `attribution:{commit:"",pr:""}` (K6a) / `includeGitInstructions:false` / env `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1` (K7) | Co-Authored-By yok |
| autoupdater, telemetry | `DISABLE_AUTOUPDATER`, `DISABLE_TELEMETRY`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` (mevcut) | "auto-updater disabled", analytics_disabled:true; proxy'de yalnız `CONNECT api.anthropic.com:443` (P2/P3) |
| plugin sync | ayrı anahtar gerekmedi | installed_plugins boş, marketplace trafiği yok |
| LSP, prefetch | doğrulanmış anahtar YOK (`ENABLE_LSP_TOOL` binary'de var, denenmedi) | LSP 0 sunucu; prefetch ağa çıkmadı |
- Binary'de hiç geçmeyen adlar: `disableAutoMemory`, `lspEnabled`, `enableLsp`, `disableSkills`, `skillsEnabled`. `--safe-mode` `--mcp-config`'i de kapatıyor (B4: mcp_servers=[]); cbm ile uyumsuz.
- `--restricted` user settings.json'u yok sayıyor (R1), `--settings`'i uyguluyor (R2), MCP'yi koruyor, memory'yi kapatıyor (B5).

## Önerilen kombinasyon (H1/H1i/H2; Win ve Linux'ta doğrulandı, validateInit ok)
- **argv:** §10.2 sırası `--bare` olmadan, artı `--include-hook-events --settings '{"disableAllHooks":true,"autoMemoryEnabled":false,"attribution":{"commit":"","pr":""},"includeGitInstructions":false}'`. İsteğe bağlı `--restricted` (H2, aynı sonuç).
- **env:** mevcut allowlist + `CLAUDE_CODE_OAUTH_TOKEN` (Linux'ta tercihen FD 3 + `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`) + `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` + `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`. `CLAUDE_CODE_SIMPLE` verilmez; `ANTHROPIC_API_KEY` token ile birlikte verilmez. API key modu mevcut `--bare` yoluyla sürebilir.
- **Sonuç:** zararlı içeriğin tamamı engellendi; user hook `--settings` ile kapandı. İstek Bearer + oauth beta ile gitti, tools 6+cbm, gövdede yalnız APPEND ve MCP kanaryası vardı. `--include-hook-events` açıkken hook olayı 0 (false-positive yok).

## Kalan riskler
1. **Token sızıntısı.** CLI OAuth token'ını Bash/hook/MCP çocuklarının env'inden siliyor (E1, K0) ama `ANTHROPIC_API_KEY`'i silmiyor (E2: Bash ve cbm görüyor; bugünkü bare modda da böyle). Linux'ta aynı uid'li bir Bash çocuğu `/proc/<claude>/environ`'dan `CLAUDE_CODE_OAUTH_TOKEN`'ı okudu (E3). FD yolunda environ'da yalnız değişken adı kalıyor (F1). Token diske yazılmadı.
2. **Mevcut ürün hatası.** `--bare` (SIMPLE) iki sürümde de tools'u Bash|Edit|Read'e indiriyor; Glob, Grep ve Write kayboluyor. validateInit eksik aracı yakalamıyor (A2, B2).
3. **Doğrulama kapsamı.** validateInit kapsamı dar (b). Non-bare'de `hook_*` → ihlal kuralı ve `--include-hook-events` eklenmeli.
4. **Kapatılamayanlar:** builtin cc-plugin native hook'ları, bundled skill/agent'lar (bare'de de var), LSP manager, non-bare prefetch.
5. **Doğrulanamayanlar:** gerçek setup-token'ın kabulü (yalnız claude-live), abonelik kotası ve rate_limit olayları, gerçek uçta OAuth'a özgü ek endpoint'ler.
6. **Windows env.** Runner Windows'ta worker'ın gerçek APPDATA/LOCALAPPDATA'sını geçiriyor (WINDOWS_BASE_ENV). Deneyde bunlar izole edildi; etkisi ölçülmedi.

## Windows ve Linux farkları
- FD ile token aktarımı yalnız Linux'ta çalışıyor; Windows'ta zorunlu yol env.
- `/proc` üzerinden environ okuma Linux'a özgü. Windows'ta aynı kullanıcının süreç belleğini okuma denenmedi. Hook'lar Windows'ta git-bash ile (`CLAUDE_CODE_GIT_BASH_PATH`), Linux'ta sh ile çalıştı. Bunun dışındaki tüm sonuçlar (A, B, K, H, M) iki platformda aynı.

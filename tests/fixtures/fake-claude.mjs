// Stand-in for the Claude Code CLI. Run as: node fake-claude.mjs --mode=<mode> [--dump=<file>] <claude args...>
import { readdirSync, writeFileSync } from 'node:fs';

const own = new Map();
const rest = [];
for (const arg of process.argv.slice(2)) {
  const m = /^--(mode|dump)=(.*)$/.exec(arg);
  if (m && rest.length === 0) own.set(m[1], m[2]);
  else rest.push(arg);
}

const mode = own.get('mode') ?? 'structured';
const dump = own.get('dump');
if (dump) {
  writeFileSync(
    dump,
    JSON.stringify({ args: rest, env: process.env, cwd: process.cwd(), files: readdirSync(process.cwd()) }),
  );
}

const invoice = {
  fatura: {
    faturaNo: 'ABC2026000000123',
    faturaTarihi: '2026-11-05',
    saticiUnvan: 'Örnek Yazılım A.Ş.',
    saticiVergiNo: '1234567890',
    aliciUnvan: 'Deneme Ltd. Şti.',
    aliciVergiNo: '9876543210',
    paraBirimi: 'TRY',
    araToplam: 1500,
    kdvToplam: 300,
    genelToplam: 1800,
  },
  kalemler: [
    { aciklama: 'Danışmanlık', miktar: 2, birim: 'saat', birimFiyat: 500, kdvOrani: 20, tutar: 1000 },
    { aciklama: 'Lisans', miktar: 1, birim: 'adet', birimFiyat: 500, kdvOrani: 20, tutar: 500 },
  ],
};

const envelope = (fields) =>
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, ...fields }));

switch (mode) {
  case 'structured':
    envelope({
      result: '',
      structured_output: invoice,
      duration_ms: 8200,
      duration_api_ms: 7400,
      num_turns: 2,
      total_cost_usd: 0.0312,
      usage: { input_tokens: 12, output_tokens: 420, cache_read_input_tokens: 15800, cache_creation_input_tokens: 0 },
      modelUsage: { 'claude-sonnet-5-5': { inputTokens: 12, outputTokens: 420 } },
    });
    break;
  case 'result-text':
    envelope({ result: 'İşte sonuç:\n```json\n' + JSON.stringify(invoice) + '\n```' });
    break;
  case 'bad-schema':
    envelope({ structured_output: { fatura: { faturaNo: 'X' }, kalemler: [] } });
    break;
  case 'garbage':
    process.stdout.write('bu JSON değil');
    break;
  case 'auth-envelope':
    envelope({ is_error: true, result: 'Invalid API key · Please run /login' });
    break;
  case 'auth-stderr':
    process.stderr.write('Not logged in · Please run /login\n');
    process.exitCode = 1;
    break;
  case 'leak':
    envelope({ is_error: true, subtype: 'error_during_execution', result: `boom ${process.env.CLAUDE_CODE_OAUTH_TOKEN}` });
    break;
  case 'slow':
    setTimeout(() => envelope({ structured_output: invoice }), 30_000);
    break;
  default:
    process.stderr.write(`unknown mode ${mode}\n`);
    process.exitCode = 2;
}

// MCP server used only by credential-leak.test.ts (claude-live). It records what the MCP child of the real CLI can
// see (ADR-0036 Decision 11 "credential-leak"), then becomes the regular fake-cbm server so the init stays valid.
// The report holds NAMES, lengths and booleans only; it never contains a credential value.
import { fstatSync, readSync, readlinkSync, writeFileSync } from 'node:fs';

const TOKEN_SHAPE = /sk-ant-/;

function describeFd3() {
  try {
    fstatSync(3);
  } catch {
    return { open: false, link: null, holdsCredential: false };
  }
  let link;
  try {
    link = readlinkSync('/proc/self/fd/3');
  } catch {
    link = 'unknown';
  }
  let holdsCredential = false;
  if (typeof link === 'string' && (link.startsWith('pipe:') || link.startsWith('/'))) {
    try {
      const buf = Buffer.alloc(4096);
      const n = readSync(3, buf, 0, buf.length, null);
      holdsCredential = n > 0 && TOKEN_SHAPE.test(buf.subarray(0, n).toString('utf8'));
    } catch {
      holdsCredential = false;
    }
  }
  return { open: true, link, holdsCredential };
}

const env = process.env;
const report = {
  credentialVarNames: Object.keys(env).filter((n) => /^CLAUDE_CODE_OAUTH_TOKEN/.test(n)),
  apiKeyPresent: Object.hasOwn(env, 'ANTHROPIC_API_KEY'),
  apiKeyLength: (env.ANTHROPIC_API_KEY ?? '').length,
  valuesWithTokenShape: Object.entries(env)
    .filter(([, v]) => typeof v === 'string' && /sk-ant-oat/.test(v))
    .map(([k]) => k),
  fd3: describeFd3(),
};
if (env.LEAK_REPORT) writeFileSync(env.LEAK_REPORT, JSON.stringify(report));

await import(new URL('../fixtures/fake-mcp/fake-cbm.mjs', import.meta.url).href);

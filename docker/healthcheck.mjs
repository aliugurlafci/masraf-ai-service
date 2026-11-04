// Container healthcheck for the Node images (api, worker, egress-proxy): GET <url> and exit 0
// on a 2xx answer, 1 otherwise. Used by docker-compose.yml so the images need neither curl
// nor a shell. Usage: node /opt/orc/healthcheck.mjs <url> [timeoutMs]
const [url, timeoutArg] = process.argv.slice(2);
const timeoutMs = Number(timeoutArg ?? '4000');

if (url === undefined || !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) {
  process.stderr.write('usage: healthcheck.mjs http://127.0.0.1:<port>/<path> [timeoutMs]\n');
  process.exit(2);
}

try {
  const response = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 4000),
  });
  await response.arrayBuffer();
  if (!response.ok) process.stderr.write(`healthcheck: ${url} answered ${response.status}\n`);
  process.exit(response.ok ? 0 : 1);
} catch (err) {
  process.stderr.write(
    `healthcheck: ${url} failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}

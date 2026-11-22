// Ping the dashboard's /healthz and exit 0 only on HTTP 200.
// Usage: bun run health   (DASHBOARD_PORT overrides the default 4319)
const port = Number(process.env.DASHBOARD_PORT ?? 4319);
const url = `http://127.0.0.1:${port}/healthz`;
try {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(3000),
  });
  if (res.status === 200) {
    console.log(`ok: ${url} answered 200`);
  } else {
    console.error(`fail: ${url} answered ${res.status}, expected 200`);
    process.exit(1);
  }
} catch (err) {
  console.error(`fail: ${url} unreachable (${err instanceof Error ? err.message : String(err)})`);
  process.exit(1);
}

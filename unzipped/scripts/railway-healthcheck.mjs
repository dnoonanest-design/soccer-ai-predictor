const port = process.env.PORT || '3000';
const url = `http://127.0.0.1:${port}/api/healthz`;
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 8000);
try {
  const res = await fetch(url, { signal: controller.signal });
  clearTimeout(timeout);
  if (!res.ok) {
    console.error(`Healthcheck failed: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  console.log(`Healthcheck OK: ${url}`);
} catch (err) {
  clearTimeout(timeout);
  console.error(`Healthcheck error: ${err?.message || err}`);
  process.exit(1);
}

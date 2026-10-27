// Temporary: measure production speed (removed before merge).
import { chromium } from "playwright";
const BASE = "https://soccer-ai-predictor-production.up.railway.app";
const note = (o) => console.log("::notice::" + JSON.stringify(o));
const time = async (path, headers = {}) => {
  const t = performance.now();
  const r = await fetch(BASE + path, { headers });
  const buf = await r.arrayBuffer();
  return { ms: Math.round(performance.now() - t), kb: Math.round(buf.byteLength / 1024), status: r.status, enc: r.headers.get("content-encoding"), cc: r.headers.get("cache-control") };
};
const matches = await (await fetch(BASE + "/api/matches")).json();
const m = (matches.find((x) => x.status === "live") ?? matches.find((x) => x.status === "upcoming"))?.id;
const paths = ["/api/matches", "/api/xg", "/api/predictions/upcoming?days=8&compact=1", "/api/model/value-signals", "/api/summary",
  `/api/matches/${m}`, `/api/matches/${m}/stats`, `/api/matches/${m}/betting-analysis`, `/api/matches/${m}/explanation`, `/api/matches/${m}/presentation`];
const rows = [];
for (const p of paths) {
  const runs = [];
  for (let i = 0; i < 3; i++) runs.push(await time(p, { "accept-encoding": "gzip, br" }));
  rows.push({ p: p.replace(String(m), ":id"), ms: runs.map((r) => r.ms), kb: runs[0].kb, enc: runs[0].enc, st: runs[0].status });
}
for (let i = 0; i < rows.length; i += 5) note(rows.slice(i, i + 5));
const b = await chromium.launch();
for (const [name, url, sel] of [["home", "/", "[data-testid^=card-match-]"], ["match", `/matches/${m}`, "[data-testid=betting-analysis]"]]) {
  for (const cold of [true, false]) {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    let bytes = 0, reqs = 0, js = 0;
    page.on("response", async (r) => { reqs++; try { const l = Number(r.headers()["content-length"] ?? (await r.body()).length); bytes += l; if (r.url().endsWith(".js")) js += l; } catch {} });
    if (!cold) { await page.goto(BASE + url, { waitUntil: "networkidle" }).catch(() => {}); bytes = 0; reqs = 0; js = 0; }
    const t = Date.now();
    await page.goto(BASE + url, { waitUntil: "domcontentloaded" }).catch(() => {});
    const dcl = Date.now() - t;
    await page.waitForSelector(sel, { timeout: 30000 }).catch(() => {});
    const content = Date.now() - t;
    await page.waitForLoadState("networkidle").catch(() => {});
    note({ page: name, cold, domReadyMs: dcl, contentShownMs: content, idleMs: Date.now() - t, requests: reqs, kb: Math.round(bytes / 1024), jsKb: Math.round(js / 1024) });
    await ctx.close();
  }
}
await b.close();
const idx = await time("/");
const html = await (await fetch(BASE + "/")).text();
const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((x) => x[1]);
const a = [];
for (const s of assets.slice(0, 6)) a.push({ s, ...(await time(s, { "accept-encoding": "gzip, br" })) });
note({ index: idx, assets: a });

// Live stream: first event and headers
{
  const ctl = new AbortController();
  const t = performance.now();
  const r = await fetch(BASE + "/api/live/stream", { signal: ctl.signal, headers: { accept: "text/event-stream" } });
  const reader = r.body.getReader(); let text = ""; let firstEventMs = null;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const { value, done } = await Promise.race([reader.read(), new Promise((ok) => setTimeout(() => ok({ value: null, done: false }), 1000))]);
    if (done) break;
    if (value) { text += new TextDecoder().decode(value); if (text.includes("event: live") && firstEventMs == null) { firstEventMs = Math.round(performance.now() - t); break; } }
  }
  ctl.abort();
  note({ stream: { status: r.status, type: r.headers.get("content-type"), enc: r.headers.get("content-encoding"), firstEventMs, sample: text.slice(0, 160) } });
}

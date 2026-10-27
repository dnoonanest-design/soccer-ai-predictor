// Temporary: screenshots of the built dashboard against live API data (removed before merge).
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const API = "https://soccer-ai-predictor-production.up.railway.app";
const DIST = path.resolve("dashboard-dist");
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) {
    const up = https.request(API + req.url, { method: req.method, headers: { accept: req.headers.accept ?? "*/*" } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(up);
    return;
  }
  let file = path.join(DIST, decodeURIComponent(req.url.split("?")[0]));
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, "index.html");
  const ext = path.extname(file);
  const type = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json" }[ext] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(4173, r));

const get = (u) => new Promise((ok, no) => https.get(API + u, (r) => { let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => { try { ok(JSON.parse(b)); } catch (e) { no(e); } }); }).on("error", no));
const matches = await get("/api/matches").catch(() => []);
const live = matches.find((m) => m.status === "live");
const withOdds = matches.find((m) => m.status === "upcoming" && m.odds?.home_odds);
const pick = live ?? withOdds ?? matches[0];
console.log("matches", matches.length, "live", !!live, "pick", pick?.id);

fs.mkdirSync("shots", { recursive: true });
const b = await chromium.launch();
const pages = [
  ["01-matches", "/"], ["02-live", "/?view=live"], ["03-edges", "/?view=edges"],
  ["04-match-summary", `/matches/${pick.id}`], ["05-match-prediction", `/matches/${pick.id}?tab=prediction`],
  ["06-match-stats", `/matches/${pick.id}?tab=stats`], ["07-match-odds", `/matches/${pick.id}?tab=odds`],
  ["08-match-teams", `/matches/${pick.id}?tab=teams`], ["09-leagues", "/leagues"],
];
for (const [w, tag] of [[1366, "desktop"], [390, "phone"]]) {
  const ctx = await b.newContext({ viewport: { width: w, height: 900 }, deviceScaleFactor: 1 });
  for (const [name, url] of pages) {
    const p = await ctx.newPage();
    const errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto("http://localhost:4173" + url, { waitUntil: "networkidle", timeout: 60000 }).catch(() => {});
    await p.waitForTimeout(2500);
    await p.screenshot({ path: `shots/${tag}-${name}.png`, fullPage: true });
    console.log(tag, name, "height", await p.evaluate(() => document.body.scrollHeight), errors.length ? "ERRORS " + errors.join(" | ") : "");
    await p.close();
  }
  await ctx.close();
}
await b.close();
server.close();

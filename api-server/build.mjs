import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import { readdir, readFile, rm } from "node:fs/promises";

// Some bundled dependencies may use `require`; keep it available in ESM output.
globalThis.require = createRequire(import.meta.url);

const artifactDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(artifactDir, "..");

async function assertCoreAiSourceIsolation() {
  const libDir = path.resolve(artifactDir, "src/lib");
  const names = await readdir(libDir);
  const coreAiFiles = names.filter((name) =>
    ((name.startsWith("ai") && name.endsWith(".ts")) || name === "adaptiveLearningEngine.ts") &&
    name !== "aiDataProvenancePolicy.ts"
  );

  const forbidden = [
    { label: "direct network fetch", regex: /\bfetch\s*\(/ },
    { label: "HTTP client", regex: /\b(?:axios|undici|got)\b/i },
    { label: "Node HTTP client", regex: /(?:node:)?https?\b/ },
    { label: "external URL", regex: /https?:\/\//i },
    { label: "market probability feature", regex: /\b(?:home_market_prob|away_market_prob|market_probability|marketOdds|bookmakerOdds|oddsMovement)\b/ },
    { label: "third-party prediction feature", regex: /\b(?:externalPrediction|onlinePrediction|consensusPrediction|thirdPartyPrediction)\b/ },
    { label: "public prediction provider", regex: /\b(?:forebet|predictz|bettingexpert)\b/i },
  ];

  const violations = [];
  for (const file of coreAiFiles) {
    const source = await readFile(path.join(libDir, file), "utf8");
    for (const rule of forbidden) {
      if (rule.regex.test(source)) violations.push(`${file}: ${rule.label}`);
    }
  }

  if (violations.length) {
    throw new Error(
      `Core AI data-isolation build check failed. AI learning must use internal app data only. Violations: ${violations.join(", ")}`,
    );
  }

  console.log(`Core AI data-isolation check passed (${coreAiFiles.length} learning files scanned)`);
}

async function buildAll() {
  const distDir = path.resolve(artifactDir, "dist");
  await rm(distDir, { recursive: true, force: true });
  await assertCoreAiSourceIsolation();

  await esbuild({
    entryPoints: [path.resolve(artifactDir, "src/index.ts")],
    platform: "node",
    bundle: true,
    format: "esm",
    outdir: distDir,
    outExtension: { ".js": ".mjs" },
    logLevel: "info",
    alias: {
      "@workspace/db": path.resolve(workspaceRoot, "lib/db/src/index.ts"),
      "@workspace/db/schema": path.resolve(workspaceRoot, "lib/db/src/schema/index.ts"),
      "@workspace/api-zod": path.resolve(workspaceRoot, "lib/api-zod/src/index.ts"),
    },
    // Native/dynamic packages and the pino logging stack are resolved at runtime.
    // Keeping pino external avoids esbuild-plugin-pino trying to resolve
    // transitive worker packages such as thread-stream during a clean CI build.
    external: [
      "*.node",
      "pino",
      "pino-http",
      "pino-pretty",
      "thread-stream",
      "sharp",
      "better-sqlite3",
      "sqlite3",
      "canvas",
      "bcrypt",
      "argon2",
      "fsevents",
      "re2",
      "farmhash",
      "xxhash-addon",
      "bufferutil",
      "utf-8-validate",
      "ssh2",
      "cpu-features",
      "dtrace-provider",
      "isolated-vm",
      "lightningcss",
      "pg-native",
      "oracledb",
      "mongodb-client-encryption",
      "nodemailer",
      "handlebars",
      "knex",
      "typeorm",
      "protobufjs",
      "onnxruntime-node",
      "@tensorflow/*",
      "@prisma/client",
      "@mikro-orm/*",
      "@grpc/*",
      "@swc/*",
      "@aws-sdk/*",
      "@azure/*",
      "@opentelemetry/*",
      "@google-cloud/*",
      "@google/*",
      "googleapis",
      "firebase-admin",
      "@parcel/watcher",
      "@sentry/profiling-node",
      "@tree-sitter/*",
      "aws-sdk",
      "classic-level",
      "dd-trace",
      "ffi-napi",
      "grpc",
      "hiredis",
      "kerberos",
      "leveldown",
      "miniflare",
      "mysql2",
      "newrelic",
      "odbc",
      "piscina",
      "realm",
      "ref-napi",
      "rocksdb",
      "sass-embedded",
      "sequelize",
      "serialport",
      "snappy",
      "tinypool",
      "usb",
      "workerd",
      "wrangler",
      "zeromq",
      "zeromq-prebuilt",
      "playwright",
      "puppeteer",
      "puppeteer-core",
      "electron",
    ],
    sourcemap: "linked",
    banner: {
      js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';

globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);
    `,
    },
  });
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});

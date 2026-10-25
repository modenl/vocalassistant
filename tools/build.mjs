// Copies only the files the site needs into dist/ for static hosting
// (Cloudflare Pages). Run: node tools/build.mjs
import { cpSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const dist = new URL('dist/', root);
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);
for (const p of ['index.html', 'sep-test.html', 'css', 'js', 'tools/speedtest-song.js']) cpSync(new URL(p, root), new URL(p, dist), { recursive: true });

// Pages response headers: allow the mic for this origin only, and revalidate
// scripts on every load so a new deploy is picked up immediately.
writeFileSync(new URL('_headers', dist), `/*
  Permissions-Policy: microphone=(self)
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin

/js/*
  Cache-Control: no-cache

/css/*
  Cache-Control: no-cache
`);
console.log('built dist/');

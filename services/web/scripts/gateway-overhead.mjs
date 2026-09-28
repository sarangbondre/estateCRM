// Gateway overhead (web LLD §8: p95 ≤ 30 ms per proxied call). Compares the same GET sent straight to the records
// contract mock and through web's gateway (session cookie → auth → rate-limit token → service token → one hop).
// Local stack only: web on 127.0.0.1:3000 (`next start`), mocks on 4010–4016, a signed-in E2E storage state.
// Usage: node scripts/gateway-overhead.mjs [samples=400]
import { readFileSync } from 'node:fs';

const N = Number(process.argv[2] ?? 400);
const WEB = process.env.WEB_URL ?? 'http://127.0.0.1:3000';
const MOCK = process.env.MOCK_URL ?? 'http://127.0.0.1:4012';
const state = JSON.parse(readFileSync(new URL('../e2e/.auth/admin.json', import.meta.url), 'utf8'));
const cookie = state.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
const path = '/v1/offers?limit=1';

async function time(url, headers) {
  const t = performance.now();
  const r = await fetch(url, { headers });
  await r.arrayBuffer();
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return performance.now() - t;
}
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

const direct = [];
const viaWeb = [];
const own = [];
const mockHeaders = {
  authorization: 'Bearer x.y.z',
  'x-user-id': '00000000-0000-4000-8000-000000000001',
  'x-user-role': 'Admin',
  'x-tenant-id': '11e00000-0000-4000-8000-000000000001',
};
// Warm up (JIT, pools, JWKS, signing key, user cache).
for (let i = 0; i < 20; i++) {
  await time(MOCK + path, mockHeaders);
  await time(WEB + path, { cookie });
}
// Interleave so both see the same load; stay under the api bucket (20/s) by pacing.
for (let i = 0; i < N; i++) {
  direct.push(await time(MOCK + path, mockHeaders));
  viaWeb.push(await time(WEB + path, { cookie }));
  own.push(await time(`${WEB}/v1/me`, { cookie }));
  await new Promise((r) => setTimeout(r, 110));
}
const out = (line) => process.stdout.write(`${line}\n`);
const row = (name, xs) => `${name.padEnd(22)} p50 ${pct(xs, 50).toFixed(1)} ms  p95 ${pct(xs, 95).toFixed(1)} ms`;
const overhead = viaWeb.map((v, i) => v - direct[i]);
out(`samples: ${N}`);
out(row('direct (mock)', direct));
out(row('through gateway', viaWeb));
out(row('gateway overhead', overhead));
out(row('own GET /v1/me', own));
out(`target: overhead p95 ≤ 30 ms → ${pct(overhead, 95) <= 30 ? 'MET' : 'NOT MET'}`);

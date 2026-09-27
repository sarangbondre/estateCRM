// Generates docs/04-lld/endpoints-table.md from contracts/openapi/*.yaml (Stage 4 gate). Port of gen_gate_tables.py.
import { readFileSync, writeFileSync } from 'node:fs';
import { load } from 'js-yaml';

const root = new URL('../', import.meta.url);
const svc = ['web', 'intake', 'records', 'journeys', 'crm-engine', 'listings', 'insight'];
const amap = { staffViaWeb: 'staff', serviceToken: 'svc', cronSecret: 'cron', websiteApiKey: 'key', clientSecret: 'client' };
const out = ['# Endpoint catalogue (generated from contracts/openapi)', '',
  'Auth: staff = staffViaWeb (signed-in user via web), svc = serviceToken, cron = X-Cron-Secret, key = website API key, client = X-Client-Secret, token = proposal share token, none = public health.', ''];
const summary = ['| Service | Operations | Public (API key) | Internal (svc/cron) |', '|---|---|---|---|'];
const sections = [];
let tot = 0;
for (const s of svc) {
  const d = load(readFileSync(new URL(`contracts/openapi/${s}.yaml`, root), 'utf8'));
  const rows = []; let pub = 0, intl = 0;
  for (const [path, pi] of Object.entries(d.paths)) {
    for (const [m, op] of Object.entries(pi)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(m)) continue;
      const sec = op.security ?? d.security ?? [];
      const keys = [...new Set((sec.length ? sec : [{}]).flatMap((r) => Object.keys(r)))].sort();
      const a = (keys.length ? keys : ['none']).map((x) => amap[x] ?? x).join(', ');
      if (a.includes('key')) pub++;
      if (path.startsWith('/internal')) intl++;
      let roles = op['x-roles'] ?? [];
      roles = Array.isArray(roles) ? (roles.length >= 5 ? 'all' : roles.join(', ')) : String(roles);
      const emits = (op['x-emits'] ?? []).join(', ') || '—';
      const summ = (op.summary ?? '').replaceAll('|', '/');
      const params = op.parameters ?? [];
      const idem = params.some((p) => String(p?.$ref ?? '').includes('IdempotencyKey')) ? 'Idempotency-Key'
        : m === 'patch' ? 'If-Match' : m === 'get' ? 'safe' : 'by design';
      const pag = op['x-paginated'] || params.some((p) => JSON.stringify(p).includes('Cursor')) ? 'yes' : '';
      rows.push(`| ${m.toUpperCase()} | \`${path}\` | ${a} | ${roles || '—'} | ${idem} | ${pag} | ${op['x-rate-limit'] ?? ''} | ${op['x-timeout-ms'] ?? ''} | ${emits} | ${summ} |`);
    }
  }
  tot += rows.length;
  summary.push(`| ${s} | ${rows.length} | ${pub} | ${intl} |`);
  sections.push(`## ${s} (${rows.length})`, '', '| Method | Path | Auth | Roles | Idempotency | Paged | Rate limit | Timeout ms | Emits | Summary |', '|---|---|---|---|---|---|---|---|---|---|', ...rows, '');
}
summary.push(`| **Total** | **${tot}** | | |`);
writeFileSync(new URL('docs/04-lld/endpoints-table.md', root), [...out, '## Summary', '', ...summary, '', ...sections].join('\n') + '\n');
process.stdout.write(`${tot}\n`);

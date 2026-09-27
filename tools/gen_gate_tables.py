"""Generates docs/04-lld/endpoints-table.md from contracts/openapi/*.yaml (Stage 4 gate). Needs PyYAML."""
import yaml, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
svc = ['web', 'intake', 'records', 'journeys', 'crm-engine', 'listings', 'insight']
out = ['# Endpoint catalogue (generated from contracts/openapi)', '',
       'Auth: staff = staffViaWeb (signed-in user via web), svc = serviceToken, cron = X-Cron-Secret, key = website API key, client = X-Client-Secret, token = proposal share token, none = public health.', '']
summary = ['| Service | Operations | Public (API key) | Internal (svc/cron) |', '|---|---|---|---|']
tot = 0
for s in svc:
    d = yaml.safe_load(open(root / f'contracts/openapi/{s}.yaml'))
    rows = []
    pub = intl = 0
    for path, pi in d['paths'].items():
        for m, op in pi.items():
            if m not in ('get', 'post', 'put', 'patch', 'delete'): continue
            sec = op.get('security', d.get('security', []))
            auth = sorted({k for req in (sec or [{}]) for k in req} ) or ['none']
            amap = {'staffViaWeb': 'staff', 'serviceToken': 'svc', 'cronSecret': 'cron', 'websiteApiKey': 'key', 'clientSecret': 'client'}
            a = ', '.join(amap.get(x, x) for x in auth)
            if 'key' in a: pub += 1
            if path.startswith('/internal'): intl += 1
            roles = op.get('x-roles') or []
            roles = 'all' if isinstance(roles, list) and len(roles) >= 5 else ', '.join(roles) if isinstance(roles, list) else str(roles)
            emits = ', '.join(op.get('x-emits') or []) or '—'
            summ = (op.get('summary') or '').replace('|', '/')
            idem = 'Idempotency-Key' if any((isinstance(p, dict) and 'IdempotencyKey' in str(p.get('$ref', ''))) for p in op.get('parameters', [])) else ('If-Match' if m == 'patch' else ('safe' if m == 'get' else 'by design'))
            pag = 'yes' if op.get('x-paginated') or any('Cursor' in str(p) for p in op.get('parameters', [])) else ''
            rows.append(f'| {m.upper()} | `{path}` | {a} | {roles or "—"} | {idem} | {pag} | {op.get("x-rate-limit","")} | {op.get("x-timeout-ms","")} | {emits} | {summ} |')
    tot += len(rows)
    summary.append(f'| {s} | {len(rows)} | {pub} | {intl} |')
    out += [f'## {s} ({len(rows)})', '', '| Method | Path | Auth | Roles | Idempotency | Paged | Rate limit | Timeout ms | Emits | Summary |', '|---|---|---|---|---|---|---|---|---|---|'] + rows + ['']
summary.append(f'| **Total** | **{tot}** | | |')
out = out[:4] + ['## Summary', ''] + summary + [''] + out[4:]
(root / 'docs/04-lld/endpoints-table.md').write_text('\n'.join(out) + '\n')
print(tot)

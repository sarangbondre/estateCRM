// Smoke test for the contract mocks (F-05): starts every mock, then checks each one serves /health/live and
// rejects an unauthenticated call to a protected route, as the contract says.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { root } from './events.mjs';

const ports = JSON.parse(readFileSync(new URL('contracts/mocks/ports.json', root), 'utf8'));
const child = spawn(process.execPath, [fileURLToPath(new URL('tools/contracts/mock.mjs', root))], {
  stdio: ['ignore', 'ignore', 'inherit'],
});

const up = async (port) => {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/health/live`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`mock on ${port} did not start`);
};

const failures = [];
try {
  for (const [svc, port] of Object.entries(ports)) {
    await up(port);
    const live = await fetch(`http://127.0.0.1:${port}/health/live`);
    if (live.status !== 200) failures.push(`${svc}: /health/live → ${live.status}`);

    // First GET route without path params that declares security: calling it without credentials must be 401.
    const spec = load(readFileSync(new URL(`contracts/openapi/${svc}.yaml`, root), 'utf8'));
    const route = Object.entries(spec.paths).find(
      ([p, item]) => !p.includes('{') && item.get && (item.get.security ?? spec.security ?? []).some((r) => Object.keys(r).length),
    );
    if (route) {
      const res = await fetch(`http://127.0.0.1:${port}${route[0]}`);
      if (res.status !== 401) failures.push(`${svc}: unauthenticated GET ${route[0]} → ${res.status}, expected 401`);
    }
    process.stdout.write(`mock ${svc} ok (:${port})\n`);
  }
} finally {
  child.kill('SIGTERM');
}
if (failures.length) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exit(1);
}

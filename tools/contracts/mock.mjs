// Runs Prism contract mocks for the named services (default: all) on the ports in contracts/mocks/ports.json (F-05).
// Usage: pnpm mock [service...] [--static]
//   default  dynamic responses generated from the response schemas
//   --static responses from spec examples/defaults only
// Requests are validated against the spec; an invalid request gets the spec's 4xx, like the real service.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { root } from './events.mjs';

const ports = JSON.parse(readFileSync(new URL('contracts/mocks/ports.json', root), 'utf8'));
const args = process.argv.slice(2);
const dynamic = !args.includes('--static');
const wanted = args.filter((a) => !a.startsWith('--'));
const services = wanted.length ? wanted : Object.keys(ports);

const unknown = services.filter((s) => !(s in ports));
if (unknown.length) {
  process.stderr.write(`unknown service(s): ${unknown.join(', ')}. Known: ${Object.keys(ports).join(', ')}\n`);
  process.exit(2);
}

// Run Prism with this Node binary so a different `node` on PATH can't be picked up.
const prism = createRequire(import.meta.url).resolve('@stoplight/prism-cli/dist/index.js');
const children = services.map((svc) => {
  const spec = fileURLToPath(new URL(`contracts/openapi/${svc}.yaml`, root));
  const child = spawn(
    process.execPath,
    [prism, 'mock', spec, '--port', String(ports[svc]), '--host', '127.0.0.1', ...(dynamic ? ['--dynamic'] : [])],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const tag = `[mock:${svc}] `;
  const relay = (stream, out) =>
    stream.on('data', (b) => out.write(b.toString().replace(/^(?=.)/gm, tag)));
  relay(child.stdout, process.stdout);
  relay(child.stderr, process.stderr);
  child.on('exit', (code) => {
    if (code) process.stderr.write(`${tag}exited with ${code}\n`);
  });
  return child;
});

process.stdout.write(
  `contract mocks: ${services.map((s) => `${s}=http://127.0.0.1:${ports[s]}`).join(' ')}\n`,
);
const stop = () => {
  for (const c of children) c.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

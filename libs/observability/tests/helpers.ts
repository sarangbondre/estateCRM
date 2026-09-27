// Test helpers: an in-memory log stream, a pull metric reader and the records contract.
import { readFileSync } from 'node:fs';
import { MetricReader } from '@opentelemetry/sdk-metrics';
import type { DataPoint, MetricData } from '@opentelemetry/sdk-metrics';
import type { OpenApiDoc } from '@11e/http';

export const recordsSpec = JSON.parse(
  readFileSync(new URL('../../../contracts/generated/openapi/records.json', import.meta.url), 'utf8'),
) as OpenApiDoc;

export const OFFER = {
  id: '6f1c2d3e-4b5a-4c6d-8e7f-001122334455',
  code: 'OFF-000001',
  propertyId: '5b0f7c1e-3a53-4c1c-9d5b-0a9a3c2f1d11',
  dealType: 'Lease',
  label: 'For Lease',
  recordStage: 'Captured',
  sourceType: 'Direct',
  status: 'active',
  createdAt: '2026-09-27T00:00:00Z',
  updatedAt: '2026-09-27T00:00:00Z',
  version: 1,
};

export function memoryStream() {
  const out: string[] = [];
  return {
    destination: { write: (s: string) => void out.push(s) },
    raw: () => out.join(''),
    lines: () => out.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

/** A pull reader: `collect()` returns everything recorded so far. */
export class TestMetricReader extends MetricReader {
  protected override async onForceFlush(): Promise<void> {}
  protected override async onShutdown(): Promise<void> {}

  async metric(name: string): Promise<MetricData | undefined> {
    const { resourceMetrics } = await this.collect();
    for (const scope of resourceMetrics.scopeMetrics) {
      const found = scope.metrics.find((m) => m.descriptor.name === name);
      if (found) return found;
    }
    return undefined;
  }

  /** Data points of a metric whose attributes include `attrs`. */
  async points(name: string, attrs: Record<string, unknown> = {}): Promise<DataPoint<unknown>[]> {
    const m = await this.metric(name);
    const points = (m?.dataPoints ?? []) as DataPoint<unknown>[];
    return points.filter((p) => Object.entries(attrs).every(([k, v]) => p.attributes[k] === v));
  }
}

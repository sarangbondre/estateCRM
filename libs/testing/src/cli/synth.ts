#!/usr/bin/env node
/**
 * 11e-synth: writes a synthetic extractor-format dataset and its expected manifest.
 *
 *   pnpm synth --rows 100000 --seed 42 --format xlsx --out /tmp/upload.xlsx [--errors 0.02] [--repeats 0.08]
 *
 * Output is written with process.stdout / process.stderr (no console, conventions §7).
 */
import { parseArgs } from 'node:util';
import { EXTRACTOR_COLUMNS, type ExtractorColumn } from '../synthetic/columns.js';
import { INJECTED_ERROR_CODES, type InjectedErrorCode, type SyntheticOptions } from '../synthetic/options.js';
import { OUTPUT_FORMATS, writeDataset, type OutputFormat } from '../synthetic/writers.js';

const USAGE = `Usage: 11e-synth --rows <n> --out <path> [options]

  --rows <n>              data rows (required)
  --out <path>            output file; with --rows-per-file, "{n}" or "-NNN" numbers the files (required)
  --format <f>            ndjson | csv | xlsx (default: from the --out extension, else ndjson)
  --seed <n>              seed, 0..2^32-1 (default 1); same seed = same output
  --errors <rate>         share of rows with one injected strict-mode error (default 0)
  --error-codes <list>    comma list of error codes to inject (default: all)
  --invalid-phones <rate> share of rows with an unparseable phone (warning, default 0)
  --repeats <rate>        share of rows re-posting an earlier ad (default 0.13)
  --flagged-repeats <r>   share of repeats carrying possible_repeat_of (default 1)
  --splits <rate>         share of rows that are split children (default 0.34)
  --outside-mmr <rate>    share of located rows outside the MMR (default 0.125)
  --whatsapp <rate>       share of WhatsApp-extractor ads (default 0)
  --from <date>           first source date, YYYY-MM-DD (default 2026-05-01)
  --to <date>             last source date, YYYY-MM-DD (default 2026-09-24)
  --people <n>            synthetic people pool (default rows / 5, max 2,000,000)
  --rows-per-file <n>     split the dataset into files of n rows (e.g. 100000 per upload)
  --omit-columns <list>   comma list of columns to leave out (file reads as mapping mode)
  --legacy-header         the 89-column header of older extractor versions (no building_name, floor; still strict)
  --anonymised            contacts in intake's anonymised form (+9100000…, example.invalid)
  --manifest <path>       manifest path (default <out>.manifest.json); "-" = do not write
  --help                  this text
`;

function fail(message: string): never {
  process.stderr.write(`11e-synth: ${message}\n\n${USAGE}`);
  process.exit(2);
}

function num(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) fail(`--${name} must be a number, got "${value}"`);
  return n;
}

function list(value: string | undefined): string[] | undefined {
  return value === undefined
    ? undefined
    : value
        .split(',')
        .map((v) => v.trim())
        .filter((v) => v !== '');
}

function formatOf(explicit: string | undefined, out: string): OutputFormat {
  const candidate = explicit ?? (out.split('.').pop() ?? 'ndjson').toLowerCase();
  const format = candidate === 'json' || candidate === 'jsonl' ? 'ndjson' : candidate;
  if (!(OUTPUT_FORMATS as readonly string[]).includes(format)) {
    if (explicit === undefined) return 'ndjson';
    fail(`--format must be one of ${OUTPUT_FORMATS.join(', ')}`);
  }
  return format as OutputFormat;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      rows: { type: 'string' },
      out: { type: 'string' },
      format: { type: 'string' },
      seed: { type: 'string' },
      errors: { type: 'string' },
      'error-codes': { type: 'string' },
      'invalid-phones': { type: 'string' },
      repeats: { type: 'string' },
      'flagged-repeats': { type: 'string' },
      splits: { type: 'string' },
      'outside-mmr': { type: 'string' },
      whatsapp: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      people: { type: 'string' },
      'rows-per-file': { type: 'string' },
      'omit-columns': { type: 'string' },
      'legacy-header': { type: 'boolean' },
      anonymised: { type: 'boolean' },
      manifest: { type: 'string' },
      help: { type: 'boolean' },
    },
    strict: true,
  });
  if (values.help === true) {
    process.stdout.write(USAGE);
    return;
  }
  const rows = num('rows', values.rows);
  if (rows === undefined) fail('--rows is required');
  if (values.out === undefined) fail('--out is required');

  const errorCodes = list(values['error-codes']);
  for (const code of errorCodes ?? []) {
    if (!(INJECTED_ERROR_CODES as readonly string[]).includes(code)) fail(`unknown error code "${code}"`);
  }
  const omit = list(values['omit-columns']);
  for (const column of omit ?? []) {
    if (!(EXTRACTOR_COLUMNS as readonly string[]).includes(column)) fail(`unknown column "${column}"`);
  }

  const entries: [keyof SyntheticOptions, unknown][] = [
    ['seed', num('seed', values.seed)],
    ['errorRate', num('errors', values.errors)],
    ['errorCodes', errorCodes as InjectedErrorCode[] | undefined],
    ['invalidPhoneRate', num('invalid-phones', values['invalid-phones'])],
    ['repeatRate', num('repeats', values.repeats)],
    ['flaggedRepeatShare', num('flagged-repeats', values['flagged-repeats'])],
    ['splitRate', num('splits', values.splits)],
    ['outsideMmrRate', num('outside-mmr', values['outside-mmr'])],
    ['whatsappRate', num('whatsapp', values.whatsapp)],
    ['dateFrom', values.from],
    ['dateTo', values.to],
    ['people', num('people', values.people)],
    ['rowsPerFile', num('rows-per-file', values['rows-per-file'])],
    ['omitColumns', omit as ExtractorColumn[] | undefined],
    ['legacyHeader', values['legacy-header']],
    ['anonymised', values.anonymised],
  ];
  const options = Object.fromEntries(entries.filter(([, v]) => v !== undefined)) as Partial<SyntheticOptions>;
  const format = formatOf(values.format, values.out);
  const manifestPath = values.manifest === '-' ? null : values.manifest;

  try {
    const result = await writeDataset(
      { ...options, rows },
      manifestPath === undefined ? { format, out: values.out } : { format, out: values.out, manifestPath },
    );
    const { totals, files } = result.manifest;
    process.stdout.write(
      `${JSON.stringify({
        format,
        files: files.map((f) => f.path),
        rows: totals.rows,
        loaded: totals.loaded,
        rejected: totals.rejected,
        needsReview: totals.needsReview,
        seconds: Math.round(result.elapsedMs) / 1000,
        rowsPerSecond: result.rowsPerSecond,
      })}\n`,
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

await main();

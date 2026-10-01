// One-time test file generator. Never runs on a request path.
// Usage: node src/generate.js [--force] [--update-checksums]
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { PURPOSE, VARIANT_SIZES, configuredVariants, dataDir, fileId } from './variants.js';

const BATCH_BYTES = 1024 * 1024;
const HEADER = 'txn_id,created,merchant_id,amount,currency,fee,net,type,description';
const CURRENCIES = ['usd', 'usd', 'usd', 'cad', 'eur', 'gbp'];
const TYPES = ['charge', 'charge', 'charge', 'charge', 'refund', 'payout', 'adjustment', 'dispute'];
const WORDS = [
  'subscription', 'invoice', 'order', 'renewal', 'upgrade', 'annual', 'monthly', 'plan',
  'checkout', 'payment', 'deposit', 'shipping', 'addon', 'seat', 'usage', 'credit',
];
const CHECKSUMS_PATH = path.join(import.meta.dirname, '..', 'checksums.json');

const log = (obj) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...obj }));

// mulberry32, seeded from sha256(seed:variant) so each file is stable on its own
function prng(seedText) {
  let a = createHash('sha256').update(seedText).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rowMaker(rand) {
  const int = (n) => Math.floor(rand() * n);
  const hex8 = () => int(0x100000000).toString(16).padStart(8, '0');
  let created = 1_750_000_000;
  return () => {
    created += int(5);
    const amount = 50 + int(250_000); // cents
    const fee = Math.round(amount * 0.029) + 30;
    const type = TYPES[int(TYPES.length)];
    const sign = type === 'refund' || type === 'dispute' ? -1 : 1;
    const cents = (c) => (c / 100).toFixed(2);
    const desc = `${WORDS[int(WORDS.length)]} ${WORDS[int(WORDS.length)]} ${1000 + int(9000)}`;
    return [
      `txn_${hex8()}${hex8()}`,
      created,
      `acct_${(100000 + int(900000)).toString(36)}`,
      cents(sign * amount),
      CURRENCIES[int(CURRENCIES.length)],
      cents(fee),
      cents(sign * amount - fee),
      type,
      desc,
    ].join(',');
  };
}

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { highWaterMark: BATCH_BYTES })) hash.update(chunk);
  return hash.digest('hex');
}

async function isCurrent(csvPath, shaPath, size) {
  try {
    if (fs.statSync(csvPath).size !== size) return null;
    const expected = fs.readFileSync(shaPath, 'utf8').trim().split(/\s+/)[0];
    return (await sha256File(csvPath)) === expected ? expected : null;
  } catch {
    return null;
  }
}

async function writeCsv(csvPath, size, seedText) {
  const nextRow = rowMaker(prng(seedText));
  const hash = createHash('sha256');
  const out = fs.createWriteStream(csvPath);

  const flush = async (rows) => {
    const buf = Buffer.from(rows.join('\n') + '\n', 'latin1');
    hash.update(buf);
    if (!out.write(buf)) await once(out, 'drain');
  };

  // Rows are ASCII, so string length is byte length.
  let batch = [HEADER];
  let batchBytes = HEADER.length + 1;
  let total = batchBytes;
  for (;;) {
    const row = nextRow();
    if (total + row.length + 1 > size) break;
    if (batchBytes >= BATCH_BYTES) {
      await flush(batch);
      batch = [];
      batchBytes = 0;
    }
    batch.push(row);
    batchBytes += row.length + 1;
    total += row.length + 1;
  }
  // Pad the last row's description so the file lands on the exact size.
  batch[batch.length - 1] += 'x'.repeat(size - total);
  await flush(batch);
  out.end();
  await finished(out);
  return hash.digest('hex');
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const force = args.has('--force');
  const seed = process.env.SEED ?? 'stream-poc-v1';
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });

  const sums = {};
  for (const variant of configuredVariants()) {
    const id = fileId(variant);
    const size = VARIANT_SIZES[variant];
    const csvPath = path.join(dir, `${id}.csv`);
    const shaPath = path.join(dir, `${id}.sha256`);
    const metaPath = path.join(dir, `${id}.json`);

    const existing = force ? null : await isCurrent(csvPath, shaPath, size);
    if (existing && fs.existsSync(metaPath)) {
      sums[variant] = existing;
      log({ msg: 'skip', variant, id, size, sha256: existing });
      continue;
    }

    const t0 = performance.now();
    const sha256 = await writeCsv(csvPath, size, `${seed}:${variant}`);
    const actual = fs.statSync(csvPath).size;
    if (actual !== size) throw new Error(`${id}: wrote ${actual} bytes, wanted ${size}`);
    fs.writeFileSync(shaPath, `${sha256}  ${id}.csv\n`);
    fs.writeFileSync(
      metaPath,
      JSON.stringify({ id, purpose: PURPOSE, variant, size, sha256, created: Math.floor(Date.now() / 1000) }, null, 2) + '\n',
    );
    sums[variant] = sha256;
    log({ msg: 'generated', variant, id, size, sha256, durationMs: Math.round(performance.now() - t0) });
  }

  if (args.has('--update-checksums')) {
    fs.writeFileSync(CHECKSUMS_PATH, JSON.stringify({ seed, sha256: sums }, null, 2) + '\n');
    log({ msg: 'checksums written', path: CHECKSUMS_PATH });
    return;
  }

  const expected = JSON.parse(fs.readFileSync(CHECKSUMS_PATH, 'utf8'));
  const bad = Object.entries(sums).filter(([v, sha]) => expected.sha256?.[v] !== sha);
  if (bad.length) {
    for (const [variant, sha256] of bad) {
      log({ msg: 'checksum mismatch', variant, sha256, expected: expected.sha256?.[variant] ?? null });
    }
    log({ msg: 'files do not match checksums.json. Wrong SEED, or rerun with --update-checksums', seed, expectedSeed: expected.seed });
    process.exitCode = 1;
    return;
  }
  log({ msg: 'all checksums match checksums.json', variants: Object.keys(sums) });
}

await main();

// Prints manifest.json for the static partner (GitHub Release assets).
// Usage: ASSET_BASE_URL=https://github.com/<owner>/<repo>/releases/download/<tag> node src/manifest.js
import fs from 'node:fs';
import path from 'node:path';
import { PURPOSE, configuredVariants, dataDir, fileId } from './variants.js';

const base = process.env.ASSET_BASE_URL;
if (!base) throw new Error('ASSET_BASE_URL is required');

const latest = {};
for (const variant of configuredVariants()) {
  const id = fileId(variant);
  const { size, sha256 } = JSON.parse(fs.readFileSync(path.join(dataDir(), `${id}.json`), 'utf8'));
  latest[variant] = { id, size, sha256, url: `${base}/${id}.csv` };
}
console.log(JSON.stringify({ purpose: PURPOSE, latest }, null, 2));

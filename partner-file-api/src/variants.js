import path from 'node:path';

const MIB = 1024 * 1024;

export const PURPOSE = 'settlement';

export const VARIANT_SIZES = {
  '10mb': 10 * MIB,
  '100mb': 100 * MIB,
  '500mb': 500 * MIB,
  '1gb': 1024 * MIB,
};

export const fileId = (variant) => `file_settle_${variant}`;

export function configuredVariants(env = process.env) {
  const list = (env.VARIANTS ?? '10mb,100mb,500mb,1gb')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  for (const v of list) {
    if (!(v in VARIANT_SIZES)) throw new Error(`unknown variant in VARIANTS: ${v}`);
  }
  return list;
}

export const dataDir = (env = process.env) => path.resolve(env.DATA_DIR ?? './data');

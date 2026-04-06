import { readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { migrateCollection } from '@trovec/core';
import type { EncryptionOptions } from '@trovec/core';
import { mergeConfig } from '../config.js';
import { resolveEncryptionFlags, resolveDestEncryptionFlags } from '../db-manager.js';
import { CliError } from '../errors.js';
import { info, success } from '../output.js';
import type { CliFlags } from '../config.js';

const TROVEC_EXT = '.trovec';

interface Location {
  dir: string;
  collectionId: string;
}

function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function detectSingleCollection(dir: string): string {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    throw new CliError(
      `Cannot read source directory: ${dir}`,
      'Check that --source points to an existing directory or .trovec file.',
    );
  }
  const matches = entries
    .filter((name) => name.endsWith(TROVEC_EXT))
    .map((name) => name.slice(0, -TROVEC_EXT.length));
  if (matches.length === 0) {
    throw new CliError(
      `No ${TROVEC_EXT} collection files found in ${dir}.`,
      'Point --source at a directory containing a .trovec file, or pass the file path directly.',
    );
  }
  if (matches.length > 1) {
    throw new CliError(
      `Multiple collections found in ${dir}: ${matches.join(', ')}.`,
      'Pass --source <file.trovec> to select one, or use --collection <id>.',
    );
  }
  return matches[0]!;
}

function parseSource(source: string, collectionFlag: string | undefined): Location {
  const resolved = resolve(source);

  if (source.endsWith(TROVEC_EXT)) {
    if (collectionFlag !== undefined) {
      throw new CliError(
        '--collection is only valid when --source points at a directory.',
        'Drop --collection, or pass --source as a directory path.',
      );
    }
    return { dir: dirname(resolved), collectionId: basename(resolved, TROVEC_EXT) };
  }

  if (!isExistingDirectory(resolved)) {
    throw new CliError(
      `--source path does not exist or is not a directory/.trovec file: ${source}`,
    );
  }

  const collectionId = collectionFlag ?? detectSingleCollection(resolved);
  return { dir: resolved, collectionId };
}

function pickDefaultSuffix(
  sourceEnc: EncryptionOptions | undefined,
  destEnc: EncryptionOptions | undefined,
  upgradeFormat: boolean,
): string {
  if (upgradeFormat) return '-v2';
  if (!sourceEnc && destEnc) return '-enc';
  if (sourceEnc && !destEnc) return '-dec';
  if (sourceEnc && destEnc) return '-rekeyed';
  return '-migrated';
}

function parseDest(dest: string | undefined, source: Location, suffix: string): Location {
  const defaultId = `${source.collectionId}${suffix}`;

  if (!dest) {
    return { dir: source.dir, collectionId: defaultId };
  }

  const resolved = resolve(dest);

  if (dest.endsWith(TROVEC_EXT)) {
    return { dir: dirname(resolved), collectionId: basename(resolved, TROVEC_EXT) };
  }

  // Treat as a directory — existing or to-be-created.
  return { dir: resolved, collectionId: defaultId };
}

function parsePreviousKey(flags: CliFlags): Array<{ key?: Buffer; password?: string }> | undefined {
  const hexKey = flags['previous-key'] as string | undefined;
  const password = flags['previous-password'] as string | undefined;

  if (!hexKey && !password) return undefined;

  if (hexKey && password) {
    throw new CliError(
      'Cannot combine --previous-key and --previous-password.',
      'Provide exactly one.',
    );
  }

  if (hexKey) {
    const buf = Buffer.from(hexKey, 'hex');
    if (buf.length !== 32) {
      throw new CliError(
        `--previous-key must be exactly 32 bytes (64 hex characters), got ${buf.length} bytes.`,
      );
    }
    return [{ key: buf }];
  }

  return [{ password: password! }];
}

export async function migrateCommand(_positionals: string[], flags: CliFlags): Promise<void> {
  const sourceArg = flags['source'] as string | undefined;
  const destArg = flags['dest'] as string | undefined;
  const fastRekey = flags['fast-rekey'] === true;
  const upgradeFormat = flags['upgrade-format'] === true;

  if (!sourceArg) {
    throw new CliError(
      '--source is required.',
      'Usage: trovec migrate --source <dir-or-file> [--dest <dir-or-file>] [options]',
    );
  }

  const merged = mergeConfig(flags);
  const sourceEncryption: EncryptionOptions | undefined = resolveEncryptionFlags(merged);
  const destEncryption: EncryptionOptions | undefined = resolveDestEncryptionFlags(flags);

  // Inject previous keys for rolling rotation
  const previousKeys = parsePreviousKey(flags);
  if (previousKeys && sourceEncryption) {
    sourceEncryption.previousKeys = previousKeys;
  }

  if (!sourceEncryption && !destEncryption && !upgradeFormat) {
    throw new CliError(
      'Migration requires a change in encryption state.',
      'Provide --new-key / --new-password to encrypt, --remove-encryption to decrypt, ' +
      '--encryption-key plus --new-key to rekey, or --upgrade-format to upgrade to v2 envelope encryption.',
    );
  }

  const source = parseSource(sourceArg, flags.collection as string | undefined);
  const suffix = pickDefaultSuffix(sourceEncryption, destEncryption, upgradeFormat);
  const dest = parseDest(destArg, source, suffix);

  const sourceFile = join(source.dir, `${source.collectionId}${TROVEC_EXT}`);
  const destFile = join(dest.dir, `${dest.collectionId}${TROVEC_EXT}`);
  info(`Migrating ${sourceFile} → ${destFile}`);

  const result = await migrateCollection({
    sourceDirectory: source.dir,
    destDirectory: dest.dir,
    collectionId: source.collectionId,
    destCollectionId: dest.collectionId,
    sourceEncryption,
    destEncryption,
    force: flags['force'] === true,
    verify: flags['no-verify'] !== true,
    fastRekey,
    upgradeFormat,
  });

  if (result.fastRekeyed) {
    info('Fast rekey: O(1) header-only rewrite (data unchanged).');
  }
  info(`Entries migrated: ${result.entryCount}`);
  if (result.walCheckpointed) {
    info('WAL sidecar detected in source — entries checkpointed into destination.');
  }
  info(`Source size:      ${result.sourceFileBytes} bytes`);
  info(`Dest size:        ${result.destFileBytes} bytes`);
  success('Migration complete. Source is unchanged; archive it manually when ready.');
}

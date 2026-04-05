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
): string {
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

export async function migrateCommand(_positionals: string[], flags: CliFlags): Promise<void> {
  const sourceArg = flags['source'] as string | undefined;
  const destArg = flags['dest'] as string | undefined;

  if (!sourceArg) {
    throw new CliError(
      '--source is required.',
      'Usage: trovec migrate --source <dir-or-file> [--dest <dir-or-file>] [options]',
    );
  }

  const merged = mergeConfig(flags);
  const sourceEncryption: EncryptionOptions | undefined = resolveEncryptionFlags(merged);
  const destEncryption: EncryptionOptions | undefined = resolveDestEncryptionFlags(flags);

  if (!sourceEncryption && !destEncryption) {
    throw new CliError(
      'Migration requires a change in encryption state.',
      'Provide --new-key / --new-password to encrypt, --remove-encryption to decrypt, or --encryption-key plus --new-key to rekey.',
    );
  }

  const source = parseSource(sourceArg, flags.collection as string | undefined);
  const suffix = pickDefaultSuffix(sourceEncryption, destEncryption);
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
  });

  info(`Entries migrated: ${result.entryCount}`);
  if (result.walCheckpointed) {
    info('WAL sidecar detected in source — entries checkpointed into destination.');
  }
  info(`Source size:      ${result.sourceFileBytes} bytes`);
  info(`Dest size:        ${result.destFileBytes} bytes`);
  success('Migration complete. Source is unchanged; archive it manually when ready.');
}

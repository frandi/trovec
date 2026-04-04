import { create, createFileDriver, withEncryption } from '@trovec/core';
import type { TrovecConfig, StorageDriver } from '@trovec/core';
import { writeProjectConfig, resolveDir, projectConfigExists, mergeConfig } from '../config.js';
import type { CliFlags, ProjectConfig } from '../config.js';
import { resolveEncryptionFlags } from '../db-manager.js';
import { CliError } from '../errors.js';
import { success, warn } from '../output.js';

const EMBEDDER_DIMENSIONS: Record<string, number> = {
  local: 64,
  openai: 1536,
  ollama: 768,
};

export async function initCommand(flags: CliFlags): Promise<void> {
  const dir = resolveDir(flags);

  if (projectConfigExists(dir)) {
    warn(`Project already initialized in ${dir}/. Use "trovec config" to update settings.`);
    return;
  }

  const embedder = flags.embedder as string | undefined;
  const dimensions = flags.dimensions
    ?? (embedder ? EMBEDDER_DIMENSIONS[embedder] : undefined);

  if (!dimensions) {
    throw new CliError(
      'Dimensions are required.',
      'Use --dimensions <N> or --embedder <name> (which infers dimensions).',
    );
  }

  const quantization = (flags.quantization ?? 'F32') as ProjectConfig['quantization'];
  const metric = (flags.metric ?? 'cosine') as ProjectConfig['metric'];
  const collectionId = flags.collection ?? 'default';

  // Resolve encryption from flags/env
  const merged = mergeConfig(flags);
  const encryptionOpts = resolveEncryptionFlags(merged);

  // Write project config
  const projectConfig: ProjectConfig = {
    dimensions,
    quantization,
    metric,
    collectionId,
    autoFlush: true,
  };

  if (embedder) {
    projectConfig.embedder = embedder;
  }

  if (encryptionOpts) {
    projectConfig.encrypted = true;
  }

  writeProjectConfig(dir, projectConfig);

  // Create and immediately close the db to initialize the storage file
  let driver: StorageDriver = createFileDriver({ directory: dir });
  if (encryptionOpts) {
    driver = withEncryption(driver, encryptionOpts);
  }

  const config: TrovecConfig = {
    dimensions,
    quantization,
    metric,
    collectionId,
    storageDriver: driver,
    autoFlush: false,
  };

  const db = await create(config);
  await db.close();

  success(`Initialized trovec project in ${dir}/`);
  success(`  dimensions:   ${dimensions}`);
  success(`  quantization: ${quantization}`);
  success(`  metric:       ${metric}`);
  success(`  collection:   ${collectionId}`);
  if (embedder) {
    success(`  embedder:     ${embedder}`);
  }
  if (encryptionOpts) {
    success(`  encryption:   AES-256-GCM (${'key' in encryptionOpts && encryptionOpts.key ? 'raw key' : 'password'})`);
  }
}

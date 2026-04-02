import { create, createFileDriver } from '@trovec/core';
import type { TrovecConfig } from '@trovec/core';
import { writeProjectConfig, resolveDir, projectConfigExists } from '../config.js';
import type { CliFlags, ProjectConfig } from '../config.js';
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

  writeProjectConfig(dir, projectConfig);

  // Create and immediately close the db to initialize the storage file
  const config: TrovecConfig = {
    dimensions,
    quantization,
    metric,
    collectionId,
    storageDriver: createFileDriver({ directory: dir }),
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
}

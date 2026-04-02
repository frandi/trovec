import { create, createFileDriver } from '@trovec/core';
import type { Trovec, TrovecConfig, Embedder } from '@trovec/core';
import { CliError } from './errors.js';
import { mergeConfig, resolveDir, projectConfigExists } from './config.js';
import type { CliFlags, MergedConfig } from './config.js';

export async function openDb(flags: CliFlags): Promise<Trovec> {
  const dir = resolveDir(flags);

  if (!projectConfigExists(dir)) {
    throw new CliError(
      `No trovec project found in ${dir}/`,
      'Run "trovec init" to set up your project.',
    );
  }

  const merged = mergeConfig(flags);

  if (!merged.dimensions) {
    throw new CliError(
      'Missing dimensions in config.',
      'Run "trovec init --dimensions <N>" to configure.',
    );
  }

  const embedder = merged.embedder ? await resolveEmbedder(merged) : undefined;

  const config: TrovecConfig = {
    dimensions: merged.dimensions,
    quantization: merged.quantization,
    metric: merged.metric,
    collectionId: merged.collectionId ?? 'default',
    storageDriver: createFileDriver({ directory: dir }),
    embedder,
    autoFlush: merged.autoFlush,
  };

  return create(config);
}

async function resolveEmbedder(config: MergedConfig): Promise<Embedder> {
  const name = config.embedder;

  switch (name) {
    case 'local': {
      const { createLocalEmbedder } = await import('@trovec/embedder-local');
      return createLocalEmbedder({ dimensions: config.dimensions, warn: false });
    }

    case 'openai': {
      try {
        const mod = await import('@trovec/embedder-openai');
        if (!config.openaiApiKey) {
          throw new CliError(
            'OpenAI API key is required.',
            'Set it via --openai-key, OPENAI_API_KEY env var, or "trovec config set --global openaiApiKey <key>".',
          );
        }
        return mod.createOpenAIEmbedder({
          apiKey: config.openaiApiKey,
          model: config.openaiModel,
          baseUrl: config.openaiBaseUrl,
        });
      } catch (err) {
        if (err instanceof CliError) throw err;
        throw new CliError(
          'OpenAI embedder not installed.',
          'Install it: npm install @trovec/embedder-openai',
        );
      }
    }

    case 'ollama': {
      try {
        const mod = await import('@trovec/embedder-ollama');
        return mod.createOllamaEmbedder({
          model: config.ollamaModel,
          baseUrl: config.ollamaUrl,
        });
      } catch (err) {
        if (err instanceof CliError) throw err;
        throw new CliError(
          'Ollama embedder not installed.',
          'Install it: npm install @trovec/embedder-ollama',
        );
      }
    }

    default:
      throw new CliError(
        `Unknown embedder "${name}".`,
        'Supported embedders: local, openai, ollama.',
      );
  }
}

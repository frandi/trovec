import { create, createFileDriver, withEncryption } from '@trovec/core';
import type { Trovec, TrovecConfig, Embedder, StorageDriver, EncryptionOptions } from '@trovec/core';
import { CliError } from './errors.js';
import { mergeConfig, resolveDir, projectConfigExists, inferConfigFromDir } from './config.js';
import type { CliFlags, MergedConfig, ProjectConfig } from './config.js';

export async function openDb(flags: CliFlags): Promise<Trovec> {
  const dir = resolveDir(flags);

  let inferred: ProjectConfig | undefined;
  if (!projectConfigExists(dir)) {
    const result = inferConfigFromDir(dir);
    if (!result) {
      throw new CliError(
        `No trovec project found in ${dir}/`,
        'Run "trovec init" to set up your project.',
      );
    }
    inferred = result;
  }

  const merged = mergeConfig(flags, inferred);

  if (!merged.dimensions) {
    throw new CliError(
      'Missing dimensions in config.',
      'Run "trovec init --dimensions <N>" to configure.',
    );
  }

  const embedder = merged.embedder ? await resolveEmbedder(merged) : undefined;
  const encryptionOpts = resolveEncryptionFlags(merged);

  let driver: StorageDriver = createFileDriver({ directory: dir });
  if (encryptionOpts) {
    driver = withEncryption(driver, encryptionOpts);
  } else if (merged.encrypted) {
    throw new CliError(
      'This project uses encryption but no key was provided.',
      'Provide --encryption-key <hex>, --encryption-password <pass>, or set TROVEC_ENCRYPTION_KEY / TROVEC_ENCRYPTION_PASSWORD.',
    );
  }

  const config: TrovecConfig = {
    dimensions: merged.dimensions,
    quantization: merged.quantization,
    metric: merged.metric,
    collectionId: merged.collectionId ?? 'default',
    storageDriver: driver,
    embedder,
    autoFlush: merged.autoFlush,
  };

  return create(config);
}

export function resolveEncryptionFlags(config: MergedConfig): EncryptionOptions | undefined {
  const hexKey = config.encryptionKey;
  const password = config.encryptionPassword;

  if (hexKey && password) {
    throw new CliError(
      'Cannot use both --encryption-key and --encryption-password.',
      'Provide exactly one.',
    );
  }

  if (hexKey) {
    const buf = Buffer.from(hexKey, 'hex');
    if (buf.length !== 32) {
      throw new CliError(
        `Encryption key must be exactly 32 bytes (64 hex characters), got ${buf.length} bytes.`,
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
      );
    }
    return { key: buf };
  }

  if (password) {
    return { password };
  }

  return undefined;
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

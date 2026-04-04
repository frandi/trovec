import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readHeaderFromDir } from './trovec-header.js';

export interface ProjectConfig {
  dimensions?: number;
  quantization?: 'F32' | 'INT8' | 'BIT';
  metric?: 'cosine' | 'euclidean' | 'dot' | 'hamming';
  embedder?: string;
  collectionId?: string;
  autoFlush?: boolean | number;
  encrypted?: boolean;
}

export interface GlobalConfig {
  embedder?: string;
  openaiApiKey?: string;
  openaiModel?: string;
  openaiBaseUrl?: string;
  ollamaUrl?: string;
  ollamaModel?: string;
  defaultFormat?: string;
  defaultTopK?: number;
}

export interface MergedConfig extends ProjectConfig, GlobalConfig {
  encryptionKey?: string;
  encryptionPassword?: string;
}

export function getGlobalConfigDir(): string {
  const xdg = process.env['XDG_CONFIG_HOME'];
  const base = xdg || join(homedir(), '.config');
  return join(base, 'trovec');
}

export function getGlobalConfigPath(): string {
  return join(getGlobalConfigDir(), 'config.json');
}

export function getProjectConfigPath(dir: string): string {
  return join(resolve(dir), 'config.json');
}

export function readGlobalConfig(): GlobalConfig {
  const path = getGlobalConfigPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as GlobalConfig;
  } catch {
    return {};
  }
}

export function writeGlobalConfig(config: GlobalConfig): void {
  const dir = getGlobalConfigDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(getGlobalConfigPath(), JSON.stringify(config, null, 2) + '\n');
}

export function readProjectConfig(dir: string): ProjectConfig {
  const path = getProjectConfigPath(dir);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as ProjectConfig;
  } catch {
    return {};
  }
}

export function writeProjectConfig(dir: string, config: ProjectConfig): void {
  mkdirSync(resolve(dir), { recursive: true });
  writeFileSync(getProjectConfigPath(dir), JSON.stringify(config, null, 2) + '\n');
}

export function projectConfigExists(dir: string): boolean {
  return existsSync(getProjectConfigPath(dir));
}

export interface CliFlags {
  dir?: string;
  collection?: string;
  format?: string;
  quiet?: boolean;
  embedder?: string;
  dimensions?: number;
  quantization?: string;
  metric?: string;
  'openai-key'?: string;
  'openai-model'?: string;
  'openai-base-url'?: string;
  'ollama-url'?: string;
  'ollama-model'?: string;
  'top-k'?: number;
  'encryption-key'?: string;
  'encryption-password'?: string;
  [key: string]: unknown;
}

export function inferConfigFromDir(dir: string): ProjectConfig | null {
  const header = readHeaderFromDir(dir);
  if (!header) return null;
  return {
    dimensions: header.dimensions,
    quantization: header.quantization as ProjectConfig['quantization'],
    metric: header.metric as ProjectConfig['metric'],
  };
}

export function mergeConfig(flags: CliFlags, fallback?: ProjectConfig): MergedConfig {
  const dir = resolveDir(flags);
  const project = readProjectConfig(dir);
  const global = readGlobalConfig();

  return {
    // Project settings (flag > project config > inferred fallback)
    dimensions: flags.dimensions ?? project.dimensions ?? fallback?.dimensions,
    quantization: (flags.quantization ?? project.quantization ?? fallback?.quantization) as ProjectConfig['quantization'],
    metric: (flags.metric ?? project.metric ?? fallback?.metric) as ProjectConfig['metric'],
    collectionId: flags.collection ?? project.collectionId,
    autoFlush: project.autoFlush,
    encrypted: project.encrypted,

    // Embedder settings (flag > env > project > global)
    embedder: flags.embedder ?? process.env['TROVEC_EMBEDDER'] ?? project.embedder ?? global.embedder,
    openaiApiKey: flags['openai-key'] ?? process.env['OPENAI_API_KEY'] ?? global.openaiApiKey,
    openaiModel: flags['openai-model'] ?? global.openaiModel,
    openaiBaseUrl: flags['openai-base-url'] ?? global.openaiBaseUrl,
    ollamaUrl: flags['ollama-url'] ?? process.env['OLLAMA_BASE_URL'] ?? global.ollamaUrl,
    ollamaModel: flags['ollama-model'] ?? global.ollamaModel,

    // Encryption settings (flag > env)
    encryptionKey: flags['encryption-key'] ?? process.env['TROVEC_ENCRYPTION_KEY'],
    encryptionPassword: flags['encryption-password'] ?? process.env['TROVEC_ENCRYPTION_PASSWORD'],

    // Output settings
    defaultFormat: flags.format ?? global.defaultFormat,
    defaultTopK: flags['top-k'] ?? global.defaultTopK,
  };
}

export function resolveDir(flags: CliFlags): string {
  return resolve(flags.dir ?? process.env['TROVEC_DIR'] ?? '.trovec');
}

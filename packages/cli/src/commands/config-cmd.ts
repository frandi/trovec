import {
  readGlobalConfig,
  writeGlobalConfig,
  readProjectConfig,
  writeProjectConfig,
  resolveDir,
  getGlobalConfigPath,
  getProjectConfigPath,
  mergeConfig,
} from '../config.js';
import { formatOutput, detectFormat } from '../output.js';
import { CliError } from '../errors.js';
import { success } from '../output.js';
import type { CliFlags } from '../config.js';

export async function configCommand(positionals: string[], flags: CliFlags): Promise<void> {
  const subcommand = positionals[0];

  switch (subcommand) {
    case 'list':
      return configList(flags);
    case 'get':
      return configGet(positionals[1], flags);
    case 'set':
      return configSet(positionals[1], positionals[2], flags);
    case 'reset':
      return configReset(flags);
    case 'path':
      return configPath(flags);
    default:
      throw new CliError(
        subcommand ? `Unknown config subcommand "${subcommand}".` : 'Config subcommand required.',
        'Available: list, get, set, reset, path',
      );
  }
}

function configList(flags: CliFlags): void {
  const merged = mergeConfig(flags);
  const format = detectFormat(flags.format as string | undefined);

  // Filter out undefined values
  const data: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(merged)) {
    if (val !== undefined) {
      data[key] = key.toLowerCase().includes('key') ? maskSecret(val as string) : val;
    }
  }

  process.stdout.write(formatOutput(data, format) + '\n');
}

function configGet(key: string | undefined, flags: CliFlags): void {
  if (!key) {
    throw new CliError('Config key is required.', 'Usage: trovec config get <key>');
  }

  const merged = mergeConfig(flags);
  const value = (merged as Record<string, unknown>)[key];

  if (value === undefined) {
    throw new CliError(`Config key "${key}" is not set.`);
  }

  process.stdout.write(String(value) + '\n');
}

function configSet(key: string | undefined, value: string | undefined, flags: CliFlags): void {
  if (!key || value === undefined) {
    throw new CliError('Key and value are required.', 'Usage: trovec config set <key> <value>');
  }

  // Parse numeric values
  const parsed: unknown = /^\d+$/.test(value) ? parseInt(value, 10) :
    value === 'true' ? true :
    value === 'false' ? false :
    value;

  if (flags.global) {
    const config = readGlobalConfig();
    (config as Record<string, unknown>)[key] = parsed;
    writeGlobalConfig(config);
    success(`Set global config: ${key} = ${value}`);
  } else {
    const dir = resolveDir(flags);
    const config = readProjectConfig(dir);
    (config as Record<string, unknown>)[key] = parsed;
    writeProjectConfig(dir, config);
    success(`Set project config: ${key} = ${value}`);
  }
}

function configReset(flags: CliFlags): void {
  const dir = resolveDir(flags);
  writeProjectConfig(dir, {});
  success('Project config reset.');
}

function configPath(flags: CliFlags): void {
  const dir = resolveDir(flags);
  process.stdout.write(`Global: ${getGlobalConfigPath()}\n`);
  process.stdout.write(`Project: ${getProjectConfigPath(dir)}\n`);
}

function maskSecret(val: string): string {
  if (val.length <= 8) return '****';
  return val.slice(0, 4) + '****' + val.slice(-4);
}

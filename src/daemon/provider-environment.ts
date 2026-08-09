import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { parse as parseDotenv } from 'dotenv';
import {
  resolveEnvironmentFile,
  type AppConfig,
} from '../config.js';
import {
  persistEnvironmentValues,
  providerApiKeyName,
} from '../provider-config.js';

export async function launchAgentProviderConfigured(
  config: AppConfig,
  environmentFile = resolveEnvironmentFile(),
): Promise<boolean> {
  let contents: string;
  try {
    contents = await readFile(environmentFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  return Boolean(parseDotenv(contents)[providerApiKeyName(config.provider)]?.trim());
}

export async function persistLaunchAgentProviderApiKey(
  config: AppConfig,
  environmentFile = resolveEnvironmentFile(),
): Promise<void> {
  if (await launchAgentProviderConfigured(config, environmentFile)) return;
  const keyName = providerApiKeyName(config.provider);
  const value = process.env[keyName]?.trim();
  if (!value) return;
  await persistEnvironmentValues(environmentFile, { [keyName]: value });
}

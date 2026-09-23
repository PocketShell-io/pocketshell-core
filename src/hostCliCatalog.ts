/** The versioned `pocketshell engines` and `pocketshell profiles` contracts. */

import {
  HostCliMalformed,
  HostCliModule,
  isRecord,
  parseObject,
  parseShape,
  type HostCliTransport,
  type JsonRecord,
} from './hostCliCommon';

const LIST_TIMEOUT_MS = 20_000;

export interface HostEngineInfo {
  id: string;
  label: string;
  family: string;
  harness: string;
  providerMark: string;
  usageProvider: string | null;
  enabled: boolean;
  available: boolean;
  availableForCreate: boolean;
  unavailableReason: string | null;
}

export interface HostProfileInfo {
  name: string;
  engine: string;
  configDir: string | null;
  isDefault: boolean;
}

function requiredString(row: JsonRecord, field: string, label: string): string {
  if (typeof row[field] !== 'string') throw new Error(`${label}.${field} must be a string`);
  return row[field] as string;
}

function defaultString(row: JsonRecord, field: string, label: string): string {
  if (row[field] === undefined) return '';
  return requiredString(row, field, label);
}

function nullableString(row: JsonRecord, field: string, label: string): string | null {
  const value = row[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`${label}.${field} must be a string or null`);
  return value;
}

function requiredBoolean(row: JsonRecord, field: string, label: string): boolean {
  if (typeof row[field] !== 'boolean') throw new Error(`${label}.${field} must be a boolean`);
  return row[field] as boolean;
}

function defaultBoolean(row: JsonRecord, field: string, label: string, fallback: boolean): boolean {
  if (row[field] === undefined) return fallback;
  return requiredBoolean(row, field, label);
}

function parseRows<T>(
  root: JsonRecord,
  field: 'engines' | 'profiles',
  readRow: (row: JsonRecord, index: number) => T,
): T[] {
  if (!Array.isArray(root[field])) throw new HostCliMalformed(`\`${field}\` must be an array`);
  return (root[field] as unknown[]).map((value, index) => {
    if (!isRecord(value)) throw new HostCliMalformed(`${field}[${index}] must be an object`);
    return readRow(value, index);
  });
}

/** Parse the envelope from `pocketshell engines list --json` (no schema field). */
export function parseHostEnginesList(raw: string): HostEngineInfo[] {
  const root = parseObject(raw);
  if (root.engines === undefined) throw new HostCliMalformed('missing the `engines` field');
  return parseShape(1, 'engines', () => parseRows(root, 'engines', (row, index) => {
    const label = `engines[${index}]`;
    return {
      id: requiredString(row, 'id', label),
      label: requiredString(row, 'label', label),
      family: defaultString(row, 'family', label),
      harness: defaultString(row, 'harness', label),
      providerMark: defaultString(row, 'provider_mark', label),
      usageProvider: nullableString(row, 'usage_provider', label),
      enabled: defaultBoolean(row, 'enabled', label, true),
      available: defaultBoolean(row, 'available', label, true),
      availableForCreate: requiredBoolean(row, 'available_for_create', label),
      unavailableReason: nullableString(row, 'unavailable_reason', label),
    };
  }));
}

/** Parse the envelope from `pocketshell profiles list --json` (no schema field). */
export function parseHostProfilesList(raw: string): HostProfileInfo[] {
  const root = parseObject(raw);
  if (root.profiles === undefined) throw new HostCliMalformed('missing the `profiles` field');
  return parseShape(1, 'profiles', () => parseRows(root, 'profiles', (row, index) => {
    const label = `profiles[${index}]`;
    return {
      name: requiredString(row, 'name', label),
      engine: requiredString(row, 'engine', label),
      configDir: nullableString(row, 'config_dir', label),
      isDefault: defaultBoolean(row, 'default', label, false),
    };
  }));
}

export class HostCliCatalog extends HostCliModule {
  constructor(transport: HostCliTransport, binary = 'pocketshell') {
    super(transport, binary);
  }

  /** `pocketshell engines list --json`; host-provided createability is authoritative. */
  async listEngines(): Promise<HostEngineInfo[]> {
    const command = `${this.binary} engines list --json`;
    return parseHostEnginesList(await this.captureJson(command, LIST_TIMEOUT_MS));
  }

  /** `pocketshell profiles list --json`; profiles are defined on the host. */
  async listProfiles(): Promise<HostProfileInfo[]> {
    const command = `${this.binary} profiles list --json`;
    return parseHostProfilesList(await this.captureJson(command, LIST_TIMEOUT_MS));
  }
}

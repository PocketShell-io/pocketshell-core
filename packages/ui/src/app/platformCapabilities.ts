/**
 * Optional platform capabilities, probed defensively.
 *
 * The shared views read optional `PocketShellApi` groups (`app.info`,
 * `app.backgroundGrace`, `diagnostics`). Two things make a bare
 * `api.x.y` read unsafe: a platform or test double may omit the group entirely
 * (`api.app` undefined), and desktop's catch-all transport doubles answer
 * every key with a function that resolves `undefined`, so a key that LOOKS
 * present proves nothing. Each probe here therefore reads inside a try, checks
 * the exact type it needs, and — for capabilities with an answer — trusts only
 * a well-formed answer, never the key's presence.
 */
import type { DiagnosticReport } from '@pocketshell/core';
import { api } from './ipc';
import type { InstalledAppInfo, PocketShellApi } from './api';

/** True only when the platform explicitly declares background grace (Android). */
export function backgroundGraceSupported(): boolean {
  try {
    return api.app?.backgroundGrace === true;
  } catch {
    return false;
  }
}

/** The installed build, or null when the platform cannot (or does not truly) answer. */
export async function readInstalledAppInfo(): Promise<InstalledAppInfo | null> {
  try {
    const info: unknown = await api.app?.info?.();
    if (typeof info !== 'object' || info === null) return null;
    const record = info as Record<string, unknown>;
    if (typeof record.versionName !== 'string' || record.versionName.trim() === '') return null;
    const versionCode = typeof record.versionCode === 'number' && Number.isSafeInteger(record.versionCode) ? record.versionCode : null;
    const applicationId = typeof record.applicationId === 'string' ? record.applicationId : '';
    return { versionName: record.versionName, versionCode, applicationId };
  } catch {
    return null;
  }
}

/** `9.9.9 (123)` for display. */
export function formatInstalledVersion(info: InstalledAppInfo): string {
  return info.versionCode === null ? info.versionName : `${info.versionName} (${info.versionCode})`;
}

type DiagnosticsGroup = NonNullable<PocketShellApi['diagnostics']>;

/** The diagnostics group when every method is callable; its first answer is still checked. */
export function diagnosticsCapability(): DiagnosticsGroup | null {
  try {
    const group = api.diagnostics;
    if (!group) return null;
    const methods: (keyof DiagnosticsGroup)[] = ['list', 'remove', 'clear', 'share'];
    return methods.every((name) => typeof group[name] === 'function') ? group : null;
  } catch {
    return null;
  }
}

function isReport(value: unknown): value is DiagnosticReport {
  if (typeof value !== 'object' || value === null) return false;
  const report = value as Record<string, unknown>;
  return typeof report.id === 'string' && typeof report.title === 'string' && typeof report.body === 'string'
    && (report.at === null || typeof report.at === 'number')
    && ['runtime-error', 'native-crash', 'imported-crash', 'imported-history'].includes(report.source as string);
}

/**
 * List reports, or null when the answer is not a report array — a platform
 * without real storage (or a catch-all double) is treated as unsupported.
 */
export async function listDiagnosticReports(group: DiagnosticsGroup): Promise<DiagnosticReport[] | null> {
  const answer: unknown = await group.list();
  if (!Array.isArray(answer)) return null;
  return answer.filter(isReport);
}

type GatewayGroup = NonNullable<PocketShellApi['gateway']>;

/**
 * The gateway-devices group (#3086) when the platform really provides it:
 * every method callable and a usable default server. Absent on a platform
 * that cannot dial through the gateway or does not keep the gateway
 * credential and pins itself — the picker then shows no device source.
 */
export function gatewayCapability(): GatewayGroup | null {
  try {
    const group = api.gateway;
    if (!group || typeof group.defaultServerUrl !== 'string' || group.defaultServerUrl === '') return null;
    const methods: (keyof GatewayGroup)[] = ['devices', 'pairings', 'clientKeys', 'addDevice'];
    return methods.every((name) => typeof group[name] === 'function') ? group : null;
  } catch {
    return null;
  }
}

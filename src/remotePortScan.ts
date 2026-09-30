import {
  parsePortScanResult,
  parseProcCwds,
  PORT_LISTENER_SCAN_COMMAND,
  procCwdCommand,
  type PortScanResult,
} from './portScanner.js';
import type { RemotePort } from './transport.js';
import type { SshCapability, SshConnectionRef, SshExecResult } from './sshCapability.js';
import {
  createRequestIdFactory,
  describeError,
  execChecked,
  SshResponseMismatchError,
} from './sshExec.js';

/**
 * The remote listener scan over a client's SSH capability: one exec for the
 * shared sentinel-delimited listener probe, then an optional best-effort
 * `/proc/<pid>/cwd` probe to label each port with its process directory.
 * A failed scan is reported, never returned as an empty port list.
 */

export const PORT_SCAN_TIMEOUT_MS = 15_000;

export interface PortScanOptions {
  createRequestId?: () => string;
  timeoutMs?: number;
}

const defaultRequestId = createRequestIdFactory('ports');

export async function scanRemotePorts(
  capability: Pick<SshCapability, 'exec'>,
  connection: SshConnectionRef,
  options: PortScanOptions = {},
): Promise<PortScanResult> {
  const createRequestId = options.createRequestId ?? defaultRequestId;
  const timeoutMs = options.timeoutMs ?? PORT_SCAN_TIMEOUT_MS;
  let raw: SshExecResult;
  try {
    raw = await execChecked(capability, connection, {
      requestId: createRequestId(),
      command: PORT_LISTENER_SCAN_COMMAND,
      timeoutMs,
    });
  } catch (error) {
    if (error instanceof SshResponseMismatchError) {
      return { ok: false, ports: [], error: 'port scan response belonged to a different SSH request or connection' };
    }
    return { ok: false, ports: [], error: describeError(error) };
  }
  const result = parsePortScanResult(raw.stdout, raw);
  if (!result.ok) return result;
  const pids = [...new Set(result.ports.map((port) => port.pid))]
    .filter((pid): pid is number => Number.isInteger(pid) && (pid as number) > 0);
  const cwdCommand = procCwdCommand(pids);
  if (!cwdCommand) return result;

  try {
    const cwdResult = await execChecked(capability, connection, {
      requestId: createRequestId(),
      command: cwdCommand,
      timeoutMs,
    });
    const cwdByPid = parseProcCwds(cwdResult.stdout);
    const ports: RemotePort[] = result.ports.map((port) => ({
      ...port,
      cwd: port.pid === null ? null : cwdByPid.get(port.pid) ?? null,
    }));
    return { ...result, ports };
  } catch {
    // Process working directories are useful labels, but never determine
    // whether the port scan succeeded — a failed or mismatched cwd probe
    // leaves the listener rows unlabelled.
    return result;
  }
}

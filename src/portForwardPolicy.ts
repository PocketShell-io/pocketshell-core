import type { PortScanResult, RemotePort } from './portScanner.js';

export type PortIntent = 'force-on' | 'force-off';
export type PortForwardOrigin = 'auto' | 'manual' | 'ssh-config';

export interface ActivePortForward {
  remotePort: number;
  origin: PortForwardOrigin;
}

export interface PortForwardPolicyConfig {
  /** Inclusive first port that may be automatically forwarded. */
  skipPortsBelow: number;
  /** Inclusive last port that may be automatically forwarded. */
  maxAutoPort: number;
  /** Additional remote ports excluded from automatic forwarding. */
  skipPorts: readonly number[];
  /** Require this many successful, nonempty scans to confirm an auto port disappeared. */
  missingScansBeforeStop: number;
  /** A failed open is held down for this many milliseconds before retry. */
  failedPortTtlMs: number;
  /** Hard ceiling aligned with the native SSH capability resource guard. */
  maxActiveForwards: number;
}

export const DEFAULT_PORT_FORWARD_POLICY: PortForwardPolicyConfig = {
  skipPortsBelow: 1024,
  maxAutoPort: 10_000,
  skipPorts: [],
  missingScansBeforeStop: 2,
  failedPortTtlMs: 60_000,
  maxActiveForwards: 8,
};

export interface PortForwardPlanInput {
  scan: PortScanResult;
  activeForwards: readonly ActivePortForward[];
  /** User opt-ins are durable desired state and can sit outside the auto range. */
  desiredManualPorts?: readonly number[];
  /** Per-port override from the user. `force-off` beats every automatic rule. */
  intents?: Readonly<Record<number, PortIntent | undefined>>;
  /** LocalForward ports owned by the SSH configuration. */
  sshConfigPorts?: readonly number[];
  autoEnabled?: boolean;
  /** remote port -> consecutive successful scans where it was missing. */
  priorMissingScans?: Readonly<Record<number, number | undefined>>;
  /** remote port -> epoch milliseconds when its last open failed. */
  failedAt?: Readonly<Record<number, number | undefined>>;
  nowMs?: number;
  config?: Partial<PortForwardPolicyConfig>;
}

export interface PortForwardPlan {
  /** Ports to pass to the native capability's open operation in this pass. */
  openPorts: number[];
  /** Existing policy-owned tunnels to close in this pass. */
  closePorts: number[];
  /** Candidate ports deferred because the native forward limit is full. */
  deferredPorts: number[];
  /** All user/automatic targets, before failure TTL and capacity are applied. */
  desiredPorts: number[];
  /** Updated absence counters. Manual and ssh-config forwards never enter it. */
  missingScans: Record<number, number>;
  /** Ports on this successful scan that fall inside the automatic range. */
  interestingPorts: number[];
}

export function isValidTcpPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

/** The shared, inclusive auto-forward window; explicit intents are handled separately. */
export function isInterestingPort(
  remotePort: number,
  config: Partial<PortForwardPolicyConfig> = {},
): boolean {
  const policy = { ...DEFAULT_PORT_FORWARD_POLICY, ...config };
  return isValidTcpPort(remotePort) &&
    remotePort >= policy.skipPortsBelow &&
    remotePort <= policy.maxAutoPort &&
    !policy.skipPorts.includes(remotePort);
}

function uniqueValidPorts(ports: readonly number[]): number[] {
  return [...new Set(ports.filter(isValidTcpPort))].sort((a, b) => a - b);
}

function scanCanProveAbsence(scan: PortScanResult): boolean {
  // A host reached over SSH always has sshd listening. A blank or failed scan
  // is therefore never permission to tear down live tunnels.
  return scan.ok && scan.ports.some((port) => isValidTcpPort(port.port));
}

/**
 * Compute tunnel effects without opening sockets. The adapter executes these
 * effects through the platform capability; the scan, intent, reconnect, and
 * teardown decisions stay shared here.
 */
export function planPortForwards(input: PortForwardPlanInput): PortForwardPlan {
  const config = { ...DEFAULT_PORT_FORWARD_POLICY, ...input.config };
  const intents = input.intents ?? {};
  const sshConfig = new Set(uniqueValidPorts(input.sshConfigPorts ?? []));
  const activeByPort = new Map<number, ActivePortForward>();
  for (const active of input.activeForwards) {
    if (isValidTcpPort(active.remotePort)) activeByPort.set(active.remotePort, active);
  }
  const activePorts = new Set(activeByPort.keys());
  const manualPorts = new Set(uniqueValidPorts(input.desiredManualPorts ?? []));
  for (const [rawPort, intent] of Object.entries(intents)) {
    const port = Number(rawPort);
    if (intent === 'force-on' && isValidTcpPort(port)) manualPorts.add(port);
  }
  for (const [rawPort, intent] of Object.entries(intents)) {
    if (intent === 'force-off') manualPorts.delete(Number(rawPort));
  }

  const observedPorts = input.scan.ok ? uniqueValidPorts(input.scan.ports.map((port: RemotePort) => port.port)) : [];
  const observed = new Set(observedPorts);
  const interestingPorts = observedPorts.filter((port) => isInterestingPort(port, config));
  const autoTargets = input.autoEnabled === false ? [] : interestingPorts.filter(
    (port) => intents[port] !== 'force-off' && !sshConfig.has(port),
  );
  const manualTargets = [...manualPorts].filter(
    (port) => intents[port] !== 'force-off' && !sshConfig.has(port),
  );
  const desired = new Set([...manualTargets, ...autoTargets]);

  const confirmedAbsence = scanCanProveAbsence(input.scan);
  const closePorts: number[] = [];
  const missingScans: Record<number, number> = {};
  for (const [port, active] of activeByPort) {
    const intent = intents[port];
    if (active.origin === 'ssh-config') continue;
    const wasAutoCreated = active.origin === 'auto' ||
      (active.origin === 'manual' && !manualPorts.has(port));
    if (intent === 'force-off' || (input.autoEnabled === false && wasAutoCreated)) {
      closePorts.push(port);
      continue;
    }
    if (manualPorts.has(port) || desired.has(port)) continue;
    // Clearing a manual override returns that live tunnel to automatic
    // ownership. It follows the same bounded disappearance sweep from then on.
    if (!wasAutoCreated) continue;
    if (!confirmedAbsence) continue;
    if (observed.has(port)) continue;
    const misses = (input.priorMissingScans?.[port] ?? 0) + 1;
    if (misses >= Math.max(1, config.missingScansBeforeStop)) closePorts.push(port);
    else missingScans[port] = misses;
  }

  const closing = new Set(closePorts);
  const retainedCount = [...activePorts].filter((port) => !closing.has(port)).length;
  const freeSlots = Math.max(0, config.maxActiveForwards - retainedCount);
  const failedAt = input.failedAt ?? {};
  const nowMs = input.nowMs ?? Date.now();
  const candidates = [...manualTargets.filter((port) => !activePorts.has(port)),
    ...autoTargets.filter((port) => !activePorts.has(port) && !manualPorts.has(port))];
  const orderedCandidates = uniqueValidPorts(candidates).sort((left, right) => {
    const leftManual = manualPorts.has(left) ? 0 : 1;
    const rightManual = manualPorts.has(right) ? 0 : 1;
    return leftManual - rightManual || left - right;
  });
  const retryable = orderedCandidates.filter((port) => {
    const failedTime = failedAt[port];
    return failedTime === undefined || nowMs - failedTime >= config.failedPortTtlMs;
  });

  return {
    openPorts: retryable.slice(0, freeSlots),
    closePorts: closePorts.sort((a, b) => a - b),
    deferredPorts: retryable.slice(freeSlots),
    desiredPorts: [...desired].sort((a, b) => a - b),
    missingScans,
    interestingPorts,
  };
}

import { describe, expect, it } from 'vitest';
import {
  isInterestingPort,
  planPortForwards,
  type ActivePortForward,
} from '../src/portForwardPolicy.js';
import type { PortScanResult } from '../src/portScanner.js';

const ports = (...numbers: number[]): PortScanResult => ({
  ok: true,
  ports: numbers.map((port) => ({ port, process: null, pid: null, cwd: null })),
  error: null,
});
const failed: PortScanResult = { ok: false, ports: [], error: 'transport closed' };

describe('interesting-port policy', () => {
  it('uses the inclusive user-service window and honors explicit exclusions', () => {
    expect(isInterestingPort(22)).toBe(false);
    expect(isInterestingPort(1023)).toBe(false);
    expect(isInterestingPort(1024)).toBe(true);
    expect(isInterestingPort(10_000)).toBe(true);
    expect(isInterestingPort(10_001)).toBe(false);
    expect(isInterestingPort(3000, { skipPorts: [3000] })).toBe(false);
    expect(isInterestingPort(65_536)).toBe(false);
  });

  it('automatically forwards discovered interesting ports and lets a user opt in outside the range', () => {
    const plan = planPortForwards({
      scan: ports(22, 1024, 3000, 10_001),
      activeForwards: [],
      desiredManualPorts: [22],
    });
    expect(plan.interestingPorts).toEqual([1024, 3000]);
    expect(plan.openPorts).toEqual([22, 1024, 3000]);
    expect(plan.desiredPorts).toEqual([22, 1024, 3000]);
  });

  it('prioritizes durable manual intent, even on a failed scan after reconnect', () => {
    const plan = planPortForwards({
      scan: failed,
      activeForwards: [],
      desiredManualPorts: [22, 8080],
    });
    expect(plan.openPorts).toEqual([22, 8080]);
    expect(plan.closePorts).toEqual([]);
  });

  it('does not treat failed or empty scans as evidence that live tunnels disappeared', () => {
    const active: ActivePortForward[] = [{ remotePort: 3000, origin: 'auto' }];
    for (const scan of [failed, ports()]) {
      const plan = planPortForwards({ scan, activeForwards: active, priorMissingScans: { 3000: 1 } });
      expect(plan.closePorts).toEqual([]);
      expect(plan.missingScans).toEqual({});
    }
  });

  it('requires two successful nonempty scans before closing a disappeared auto tunnel', () => {
    const active: ActivePortForward[] = [{ remotePort: 3000, origin: 'auto' }];
    const firstMiss = planPortForwards({ scan: ports(8080), activeForwards: active });
    expect(firstMiss.closePorts).toEqual([]);
    expect(firstMiss.missingScans).toEqual({ 3000: 1 });
    const secondMiss = planPortForwards({
      scan: ports(8080),
      activeForwards: active,
      priorMissingScans: firstMiss.missingScans,
    });
    expect(secondMiss.closePorts).toEqual([3000]);
    expect(secondMiss.openPorts).toEqual([8080]);
  });

  it('keeps manual desired ports alive across scans where the service is absent', () => {
    const plan = planPortForwards({
      scan: ports(3000),
      activeForwards: [
        { remotePort: 22, origin: 'manual' },
        { remotePort: 3000, origin: 'auto' },
      ],
      desiredManualPorts: [22],
    });
    expect(plan.closePorts).toEqual([]);
    expect(plan.missingScans).toEqual({});
  });

  it('closes forced-off tunnels immediately and blocks SSH-config-owned ports', () => {
    const plan = planPortForwards({
      scan: ports(3000, 4000),
      activeForwards: [
        { remotePort: 3000, origin: 'auto' },
        { remotePort: 4000, origin: 'ssh-config' },
      ],
      intents: { 3000: 'force-off', 4000: 'force-off' },
      sshConfigPorts: [4000],
    });
    expect(plan.openPorts).toEqual([]);
    expect(plan.closePorts).toEqual([3000]);
  });

  it('bounds native tunnels at eight and uses a TTL for failed open attempts', () => {
    const active = Array.from({ length: 7 }, (_, index) => ({
      remotePort: index + 2000,
      origin: 'auto' as const,
    }));
    const plan = planPortForwards({
      scan: ports(8080, 8081),
      activeForwards: active,
      desiredManualPorts: [22],
      failedAt: { 22: 99_000 },
      nowMs: 100_000,
    });
    expect(plan.openPorts).toEqual([8080]);
    expect(plan.deferredPorts).toEqual([8081]);
    const expired = planPortForwards({
      scan: ports(),
      activeForwards: [],
      desiredManualPorts: [22],
      failedAt: { 22: 1 },
      nowMs: 61_000,
    });
    expect(expired.openPorts).toEqual([22]);
  });
});

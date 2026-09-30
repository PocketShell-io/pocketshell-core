/**
 * What the workspace's lost-link strip says while a recovery-owning transport
 * (`ssh.reconnect` present, #2954) walks its own ladder: the host, and which
 * dial of how many is on the wire. The schedule is the transport's, so there
 * is no countdown — and no second button to race it.
 */
export function transportRetryText(
  host: string | null | undefined,
  retry: { attempt: number; maxAttempts: number | null },
): string {
  const name = host ?? 'the host';
  if (retry.attempt < 1) return `Lost the connection to ${name}. Reconnecting…`;
  const of = retry.maxAttempts ? ` of ${retry.maxAttempts}` : '';
  return `Lost the connection to ${name}. Reconnecting — attempt ${retry.attempt}${of}.`;
}

/**
 * The standing sentence once the link is down and nobody is re-dialling. A
 * recovery-owning transport that gave up says why (e.g. how many dials it
 * made), which beats the generic line.
 */
export function linkDownText(host: string | null | undefined, transportReason: string | null): string {
  const frozen = 'The sessions and terminals on screen are frozen until you reconnect.';
  if (transportReason) return `${transportReason} ${frozen}`;
  return `Connection to ${host ?? 'the host'} was lost. ${frozen}`;
}

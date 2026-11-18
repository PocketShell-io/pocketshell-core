/**
 * Shared Chrome DevTools Protocol helpers for the real-Chromium layout tests
 * (settings / compact sheets / files+ports). Two races made those tests flaky
 * under CI load, and both live here now so no test re-implements them:
 *
 *  1. Navigating the one reused page target: `Page.navigate` resolves before the
 *     OLD document is gone, so "wait for the selector" passed on the previous
 *     test's page and the probe then ran against the fresh, still empty one
 *     (`null.textContent`). {@link gotoAndWait} puts a unique token in the URL
 *     and only treats the page as ready once THAT document answers.
 *  2. DOM reads straight after a click/resize: {@link Cdp.evaluate} retries an
 *     expression that throws (a null deref because the element is not there
 *     yet) until it succeeds or the deadline passes. Probes here are reads or
 *     idempotent clicks that throw before acting, so a retry is safe.
 */
export const sleep = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms));

export class Cdp {
  private id = 0;
  private waiting = new Map<number, (m: { result?: unknown; error?: unknown }) => void>();
  constructor(private ws: WebSocket) {
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data));
      this.waiting.get(msg.id)?.(msg);
    };
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<{ result?: any }> {
    return new Promise((ok, fail) => {
      const id = ++this.id;
      this.waiting.set(id, (m) => (m.error ? fail(new Error(JSON.stringify(m.error))) : ok(m as { result?: any })));
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** One evaluation, no retry. */
  async evaluateOnce<T>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result.result.value as T;
  }

  /** Evaluate, retrying while the expression throws (element not rendered yet). */
  async evaluate<T>(expression: string, timeoutMs = 15_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        return await this.evaluateOnce<T>(expression);
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await sleep(100);
      }
    }
  }
}

/** Poll until `expression` evaluates truthy (throwing counts as "not yet"). */
export async function waitForExpression(cdp: Cdp, expression: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = 'never evaluated';
  while (Date.now() < deadline) {
    try {
      if (await cdp.evaluateOnce<boolean>(`!!(${expression})`)) return;
      last = 'falsy';
    } catch (error) {
      last = error instanceof Error ? error.message.slice(0, 200) : String(error);
    }
    await sleep(100);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${expression} (last: ${last})`);
}

export function waitForSelector(cdp: Cdp, selector: string, timeoutMs = 30_000): Promise<void> {
  return waitForExpression(cdp, `document.querySelector(${JSON.stringify(selector)})`, timeoutMs);
}

let navigations = 0;

/**
 * Navigate and wait until the NEW document is up and `readySelector` exists in
 * it. The URL carries a unique `_nav` token; ready means `location.search`
 * contains it, so a previous test's page can never satisfy the wait.
 */
export async function gotoAndWait(cdp: Cdp, url: string, readySelector: string, timeoutMs = 45_000): Promise<void> {
  navigations += 1;
  const token = `${Date.now().toString(36)}-${navigations}`;
  const target = `${url}${url.includes('?') ? '&' : '?'}_nav=${token}`;
  await cdp.send('Page.navigate', { url: target });
  await waitForExpression(
    cdp,
    `location.search.includes(${JSON.stringify(`_nav=${token}`)}) && document.readyState !== 'loading' && document.querySelector(${JSON.stringify(readySelector)})`,
    timeoutMs,
  );
}

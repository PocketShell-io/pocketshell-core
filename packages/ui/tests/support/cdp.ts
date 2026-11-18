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

  /**
   * One evaluation, no retry. Bounded: a `Runtime.evaluate` issued while the page
   * is navigating can be left unanswered when its execution context is replaced
   * (measured: ~25s on the first navigation of a fresh Chromium), so an answer
   * that does not come within `callTimeoutMs` is an error the callers retry.
   */
  async evaluateOnce<T>(expression: string, callTimeoutMs = 5_000): Promise<T> {
    const r = await Promise.race([
      this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
      sleep(callTimeoutMs).then(() => {
        throw new Error(`Runtime.evaluate unanswered after ${callTimeoutMs}ms`);
      }),
    ]);
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
export async function gotoAndWait(cdp: Cdp, url: string, readySelector: string, timeoutMs = 90_000): Promise<void> {
  // Re-navigate when a load wedges: under load Vite can answer a late-discovered
  // dependency with "outdated optimized dep" / reload the graph mid-import, which
  // leaves a page whose entry module threw and will never render. A fresh load
  // (new token) recovers; waiting longer on the dead one never does.
  const attempts = 3;
  const perAttempt = Math.ceil(timeoutMs / attempts);
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    navigations += 1;
    const token = `${Date.now().toString(36)}-${navigations}`;
    const target = `${url}${url.includes('?') ? '&' : '?'}_nav=${token}`;
    try {
      await cdp.send('Page.navigate', { url: target });
      await waitForExpression(
        cdp,
        `location.search.includes(${JSON.stringify(`_nav=${token}`)}) && document.readyState !== 'loading' && document.querySelector(${JSON.stringify(readySelector)})`,
        perAttempt,
      );
      return;
    } catch (error) {
      last = error;
    }
  }
  throw last;
}

/**
 * Pre-request the harness page and its entry module so Vite finishes its cold
 * work (dependency discovery, first transforms) before any test clock starts.
 * Measured: the browser's first document request took ~25s to be answered
 * (Vite's cold HTML transform + dependency scan); on a loaded CI runner that
 * exceeded the 45s navigation wait.
 */
export async function warmServer(origin: string, entry = '/main.ts'): Promise<void> {
  // `Accept: text/html` matters: Vite only runs the (slow, cold) HTML transform and
  // dependency scan for a navigation-style request, not for a bare fetch.
  await fetch(`${origin}/?warm=1`, {
    headers: { Accept: 'text/html,application/xhtml+xml', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'User-Agent': 'Mozilla/5.0 Chrome/130' },
  }).then((r) => r.text());
  await fetch(`${origin}${entry}`).then((r) => r.text());
}

/**
 * The first `Page.navigate` of a freshly started Chromium can sit unanswered for
 * ~25s (measured; it is the browser's first navigation, not Vite or the page).
 * Pay that once, here, with a generous bound and OUTSIDE any test's clock, so the
 * navigations the tests time are already on a warm browser.
 */
export async function warmBrowser(cdp: Cdp, origin: string, timeoutMs = 120_000): Promise<void> {
  await Promise.race([
    cdp.send('Page.navigate', { url: `${origin}/?warm=browser` }),
    sleep(timeoutMs).then(() => {
      throw new Error(`first Page.navigate unanswered after ${timeoutMs}ms`);
    }),
  ]);
  await waitForExpression(cdp, `location.search.includes('warm=browser') && document.readyState === 'complete'`, timeoutMs);
}

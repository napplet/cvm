/** Protocol fixture with a real timer and AbortSignal, no network/provider. */
export function delayedResponse(delayMs: number, signal: AbortSignal | null | undefined, response: Response): Promise<Response> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException("Fixture request aborted", "AbortError")); return; }
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new DOMException("Fixture request aborted", "AbortError")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(response); }, delayMs);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

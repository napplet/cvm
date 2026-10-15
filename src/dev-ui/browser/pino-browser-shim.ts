/** Browser-only logger adapter for the SDK's documented browser logger path. */
type Logger = { child(): Logger; debug(...args: unknown[]): void; info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void };
const silent: Logger = { child: () => silent, debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

function pino(): Logger { return silent; }
(pino as typeof pino & { stdTimeFunctions: { isoTime: () => string } }).stdTimeFunctions = { isoTime: () => new Date().toISOString() };

export default pino;

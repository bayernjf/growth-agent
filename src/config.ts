// growth-agent configuration: env parsing with safe defaults.
// Every external dependency (zeus, connectors, publishers) defaults to
// off/offline and fails closed when selected without the required config.

export interface AppConfig {
  host: string;
  port: number;
  apiToken?: string | undefined;
  dbDriver: 'sqlite' | 'postgres';
  sqlitePath: string;
  /** zeus decision kernel integration (T-A3). off = deterministic offline. */
  zeusMode: 'off' | 'online';
  zeusUrl?: string | undefined;
  zeusToken?: string | undefined;
  /** Public URL zeus POSTs lifecycle events to (self-check re-subscription). */
  zeusCallbackUrl?: string | undefined;
  /** Shared secret (>=16 chars) zeus HMAC-signs outbound events with. */
  zeusWebhookSecret?: string | undefined;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(): AppConfig {
  const dbDriver = process.env.GA_DB_DRIVER === 'postgres' ? 'postgres' : 'sqlite';
  const zeusMode = process.env.GA_ZEUS_MODE === 'online' ? 'online' : 'off';
  return {
    host: process.env.GA_HOST ?? '127.0.0.1',
    port: num('GA_PORT', 8790),
    apiToken: process.env.GA_API_TOKEN || undefined,
    dbDriver,
    sqlitePath: process.env.GA_SQLITE_PATH ?? './data/growth-agent.db',
    zeusMode,
    zeusUrl: process.env.GA_ZEUS_URL || undefined,
    zeusToken: process.env.GA_ZEUS_TOKEN || undefined,
    zeusCallbackUrl: process.env.GA_ZEUS_CALLBACK_URL || undefined,
    zeusWebhookSecret: process.env.GA_ZEUS_WEBHOOK_SECRET || undefined,
  };
}

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
  /** GSC read-only connector (T-B1/B2). off = deterministic offline fixture. */
  gscMode: 'off' | 'online';
  gscClientId?: string | undefined;
  gscClientSecret?: string | undefined;
  /** Directory holding the sealed refresh-token file (§8 gsc_tokens volume). */
  gscTokenDir: string;
  /** §8 GROWTH_MASTER_KEY (AES-256 key for the sealed GSC token; env-only). */
  growthMasterKey?: string | undefined;
  /** SERP BYOK connector (T-C1). off = deterministic offline fixture. */
  serpMode: 'off' | 'online';
  /** DataForSEO HTTP-BASIC credentials (login + password; BYOK). */
  serpLogin?: string | undefined;
  serpPassword?: string | undefined;
  /** GitHub publisher (T-D2/D3). off = deterministic offline fake publisher. */
  githubMode: 'off' | 'online';
  /** PAT with repo scope (least privilege); server-side only, never logged. */
  githubToken?: string | undefined;
  /** Default target repository owner/login for openChange. */
  githubOwner?: string | undefined;
  /** Default target repository name for openChange. */
  githubRepo?: string | undefined;
  /** Base branch PRs are opened against (default main). */
  githubBaseBranch: string;
  /** Shared secret for verifying X-Hub-Signature-256 inbound PR events. */
  githubWebhookSecret?: string | undefined;
  /** §11.1 JSON map of provider -> micros per unit; malformed fails closed. */
  costRates?: string | undefined;
  /** Directory versioned weekly reports are written to (design §5.E). */
  reportDir: string;
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
  const gscMode = process.env.GA_GSC_MODE === 'online' ? 'online' : 'off';
  const serpMode = process.env.GA_SERP_MODE === 'online' ? 'online' : 'off';
  const githubMode = process.env.GA_GITHUB_MODE === 'online' ? 'online' : 'off';
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
    gscMode,
    gscClientId: process.env.GA_GSC_CLIENT_ID || undefined,
    gscClientSecret: process.env.GA_GSC_CLIENT_SECRET || undefined,
    gscTokenDir: process.env.GA_GSC_TOKEN_DIR ?? './data/gsc-tokens',
    growthMasterKey: process.env.GA_GROWTH_MASTER_KEY || undefined,
    serpMode,
    serpLogin: process.env.GA_SERP_DATAFORSEO_LOGIN || undefined,
    serpPassword: process.env.GA_SERP_DATAFORSEO_PASSWORD || undefined,
    githubMode,
    githubToken: process.env.GA_GITHUB_TOKEN || undefined,
    githubOwner: process.env.GA_GITHUB_OWNER || undefined,
    githubRepo: process.env.GA_GITHUB_REPO || undefined,
    githubBaseBranch: process.env.GA_GITHUB_BASE_BRANCH || 'main',
    githubWebhookSecret: process.env.GA_GITHUB_WEBHOOK_SECRET || undefined,
    costRates: process.env.GA_COST_RATES || undefined,
    reportDir: process.env.GA_REPORT_DIR ?? './data/reports',
  };
}

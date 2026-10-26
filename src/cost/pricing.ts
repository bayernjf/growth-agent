// §11.1 cost estimation: micro-USD cost per unit, provider by provider.
//
// BYOK semantics: this is an ESTIMATE of spend against the operator's own
// provider account; the authoritative bill is the provider's dashboard.
// Rates are zero by default (offline mode costs nothing) and can be
// overridden with GA_COST_RATES, a JSON map of
// `{ "<provider>": <micros per unit> }`, e.g.
//   GA_COST_RATES='{"serp:dataforseo":1200,"llm":0.25}'
// Malformed config fails closed (never silently zeroes a real bill).

import { GrowthAgentErrors } from '../errors.js';

export interface CostRates {
  /** Provider name -> micros per unit (rows/tokens/requests). */
  microsPerUnit: Record<string, number>;
}

export function parseCostRates(raw: string | undefined): CostRates {
  if (raw === undefined || raw === '') return { microsPerUnit: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw GrowthAgentErrors.validation(
      'GA_COST_RATES must be a JSON object of {"provider": microsPerUnit}',
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw GrowthAgentErrors.validation(
      'GA_COST_RATES must be a JSON object of {"provider": microsPerUnit}',
    );
  }
  const microsPerUnit: Record<string, number> = {};
  for (const [provider, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw GrowthAgentErrors.validation(
        `GA_COST_RATES: rate for "${provider}" must be a non-negative number`,
      );
    }
    microsPerUnit[provider] = value;
  }
  return { microsPerUnit };
}

export class Pricing {
  constructor(private readonly rates: CostRates = { microsPerUnit: {} }) {}

  /** Estimated cost for one call returning `units` units; integer micros. */
  estimate(provider: string, units: number): number {
    const rate = this.rates.microsPerUnit[provider] ?? 0;
    return Math.round(rate * units);
  }
}

// Intent gate (T-E1, design §6.3.1 + §5.4). Deterministic rule version of the
// future atlas-backed classifier: it labels each top-10 SERP result with a
// morphology (transactional / navigational / commercial / news /
// encyclopedic) and requires the intended content type to fit the SERP.
//
// Hard rule (§5.4 / §10): transactional or navigational queries that do not
// match the site's product are discarded — growth-agent never manufactures
// editorial pages to chase transactional rankings.
//
// Thresholds are rule-version constants; the docs give no numeric cut-offs,
// so they are documented here for calibration during dogfood (T-H4).

import type { SerpResult } from '../connector/serp/types.js';
import type {
  ClassifyIntentInput,
  ContentKind,
  GateVerdict,
  IntentAssessment,
  IntentClassifierPort,
  SerpForm,
} from './types.js';

/** Dominant morphology needs at least this share; otherwise the SERP is mixed. */
export const DOMINANT_FORM_SHARE = 0.5;
/**
 * Informational articles (write tasks) need at least this share of
 * encyclopedic/news results; below it the SERP is not an editorial fit.
 */
export const INFORMATIONAL_ALIGNMENT_MIN = 0.4;

const TRANSACTIONAL_PATTERNS =
  /\b(buy|price|prices|pricing|deal|deals|discount|coupon|cheap|order|checkout|purchase|for sale|subscription plan|quote)\b|购买|价格|多少钱|优惠|打折|套餐|下单|订购|报价/i;
const NAVIGATIONAL_PATTERNS =
  /\b(login|log in|sign in|signup|homepage|official site|my account|dashboard)\b|facebook\.com|twitter\.com|instagram\.com|youtube\.com|github\.com|登录|登陆|官网首页|官方网站/i;
const NEWS_PATTERNS =
  /\b(news|breaking|announces?|announced|press release|reported|reports?\b|latest update)\b|新闻|报道|讯$|发布通告/i;
const COMMERCIAL_PATTERNS =
  /\b(best|top \d+|review|reviews|vs\.?|versus|comparison|alternative|alternatives|vendor|vendors|provider|providers|software|tools?)\b|评测|测评|对比|哪个好|排行榜|推荐/i;
const ENCYCLOPEDIC_PATTERNS =
  /\b(what is|what are|how to|why |guide|tutorial|learn|definition|meaning|encyclopedia|wiki|example|examples|tips|introduction|complete guide|ultimate guide)\b|是什么|怎么|怎样|如何|教程|指南|百科|入门|知识|原理/i;

/**
 * Label one SERP result. Classification priority:
 * transactional → navigational → news → commercial → encyclopedic, because
 * explicit purchase/navigation intent is a hard discard regardless of
 * informational wording elsewhere on the page.
 */
export function labelSerpResult(result: SerpResult): SerpForm {
  // Morphology is read from the result's own wording (title + description).
  // The URL is only used for authoritative reference domains: matching URL
  // path fragments against word patterns (e.g. "/example" containing
  // "example") produces false labels.
  const haystack = `${result.title} ${result.description}`;
  if (/wikipedia\.org|wikihow\.com|britannica\.com|baike\.baidu\.com|zhihu\.com\/question/i.test(result.url)) {
    return 'encyclopedic';
  }
  if (TRANSACTIONAL_PATTERNS.test(haystack)) return 'transactional';
  if (NAVIGATIONAL_PATTERNS.test(haystack)) return 'navigational';
  if (NEWS_PATTERNS.test(haystack)) return 'news';
  if (COMMERCIAL_PATTERNS.test(haystack)) return 'commercial';
  if (ENCYCLOPEDIC_PATTERNS.test(haystack)) return 'encyclopedic';
  return 'mixed';
}

function share(labels: SerpForm[], forms: readonly SerpForm[]): number {
  if (labels.length === 0) return 0;
  const hits = labels.filter((l) => forms.includes(l)).length;
  return hits / labels.length;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Deterministic offline intent classifier (T-E1). */
export class RuleBasedIntentClassifier implements IntentClassifierPort {
  async classify(input: ClassifyIntentInput): Promise<IntentAssessment> {
    const labels = input.serp.map(labelSerpResult);
    const informational = share(labels, ['encyclopedic', 'news']);
    const transactional = share(labels, ['transactional']);
    const navigational = share(labels, ['navigational']);
    const commercial = share(labels, ['commercial']);

    // A fix targets an existing page that already has GSC exposure; the
    // intent is validated by that exposure (value gate checks impressions).
    if (input.contentKind === 'page_fix') {
      return {
        form: dominantForm(labels),
        alignmentScore: 1,
        labels,
        reasons: [
          'fix task targets an existing GSC-ranked page; intent proven by current exposure',
        ],
      };
    }

    const reasons: string[] = [
      `top-10 shares: informational=${round2(informational)} transactional=${round2(
        transactional,
      )} navigational=${round2(navigational)} commercial=${round2(commercial)}`,
    ];
    return {
      form: dominantForm(labels),
      alignmentScore: round2(informational),
      labels,
      reasons,
    };
  }
}

function dominantForm(labels: SerpForm[]): SerpForm {
  const counts = new Map<SerpForm, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  let best: SerpForm = 'mixed';
  let bestCount = 0;
  for (const [form, count] of counts) {
    if (form === 'mixed' || count <= bestCount) continue;
    best = form;
    bestCount = count;
  }
  if (labels.length > 0 && bestCount / labels.length >= DOMINANT_FORM_SHARE) {
    return best;
  }
  return 'mixed';
}

function isInformationalKind(kind: ContentKind): boolean {
  return kind === 'informational_article';
}

/**
 * Run the intent gate. Returns a verdict with an explicit discard action when
 * a write task targets a transactional/navigational SERP or the informational
 * alignment is below threshold.
 */
export async function intentGate(
  input: ClassifyIntentInput,
  classifier: IntentClassifierPort = new RuleBasedIntentClassifier(),
): Promise<GateVerdict> {
  const assessment = await classifier.classify(input);
  if (!isInformationalKind(input.contentKind)) {
    return {
      gate: 'intent',
      pass: true,
      score: assessment.alignmentScore,
      reasons: assessment.reasons,
    };
  }

  const transactional = share(assessment.labels, ['transactional']);
  const navigational = share(assessment.labels, ['navigational']);
  if (transactional >= DOMINANT_FORM_SHARE) {
    return {
      gate: 'intent',
      pass: false,
      score: round2(assessment.alignmentScore),
      action: 'discard',
      reasons: [
        ...assessment.reasons,
        `transactional SERP dominant (${round2(transactional)}); editorial page mismatches purchase intent`,
      ],
    };
  }
  if (navigational >= DOMINANT_FORM_SHARE) {
    return {
      gate: 'intent',
      pass: false,
      score: round2(assessment.alignmentScore),
      action: 'discard',
      reasons: [
        ...assessment.reasons,
        `navigational SERP dominant (${round2(navigational)}); users seek a specific brand/site, not new content`,
      ],
    };
  }
  if (assessment.alignmentScore < INFORMATIONAL_ALIGNMENT_MIN) {
    return {
      gate: 'intent',
      pass: false,
      score: round2(assessment.alignmentScore),
      action: 'discard',
      reasons: [
        ...assessment.reasons,
        `informational alignment ${round2(assessment.alignmentScore)} below ${INFORMATIONAL_ALIGNMENT_MIN}; SERP morphology ${assessment.form} does not fit an editorial article`,
      ],
    };
  }
  return {
    gate: 'intent',
    pass: true,
    score: round2(assessment.alignmentScore),
    reasons: assessment.reasons,
  };
}

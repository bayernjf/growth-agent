// Value gate (T-E3, design §5.4 + §6.3.3 + §10). Two independent checks:
//
// 1. Demand (§5.3): a write candidate needs real SERP demand (monthly volume
//    at/above the baseline); a fix candidate needs the page to already have
//    GSC organic impressions (impressions > 0). No demand → drop.
// 2. Non-commodity content (§6.3.3, Google 2026-05 generative AI features
//    guidance): the draft must not be dominated by boilerplate/template
//    paragraphs and must carry a minimum share of unique information
//    (proprietary data, concrete cases, local specifics).
//
// Rule version: the docs define the rule but no numeric thresholds; the
// constants below are documented dogfood calibration points (T-H4).

import type { ContentDraft, GateVerdict, GscPageEvidence } from './types.js';

/** Write candidates need at least this monthly volume (§5.3 "volume≥基准"; number pending dogfood). */
export const WRITE_VOLUME_MIN = 50;
/** Fix candidates need at least one organic impression (§5.3). */
export const FIX_IMPRESSIONS_MIN = 1;
/** Max share of template/boilerplate paragraphs (§6.3.3). */
export const TEMPLATE_PARAGRAPH_RATIO_MAX = 0.3;
/** Min share of paragraphs carrying unique information (§6.3.3). */
export const UNIQUE_INFO_RATIO_MIN = 0.2;
/** A draft with fewer paragraphs is too thin to evaluate as an article. */
export const MIN_PARAGRAPHS = 3;

const BOILERPLATE_PATTERNS =
  /(welcome to our website|in today'?s fast[- ]paced world|as a leading (provider|company)|we are committed to providing|our team of experts|contact us today|lorem ipsum|at your service|one[- ]stop solution|tailor(ed)? solutions?|look no further|欢迎来到|致力于为(客户|广大用户)|专业的团队|一流的服务|如有疑问.*联系|随着社会的发展|在当今社会|众所周知)/i;

const UNIQUE_INFO_PATTERNS =
  /(\b\d{2,}|\b\d+(?:\.\d+)?%|percent|百分|我们(实测|发现|数据|案例|统计)|根据我们|实测|案例|例如|本地|本机|本仓|in our (experience|tests?|data)|we (found|measured|observed|ran)|according to our|for example|e\.g\.|table \d+|figure \d+|20\d{2}-\d{2})/i;

export interface ValueInput {
  draft: ContentDraft;
  /** Max monthly volume for write candidates; absent means zero known demand. */
  keywordVolume?: number | undefined;
  /** GSC pages of the target query/page (fix candidates). */
  gscPages: GscPageEvidence[];
}

export interface ValueBreakdown {
  demandPass: boolean;
  demandScore: number;
  templateRatio: number;
  uniqueInfoRatio: number;
  qualityPass: boolean;
  reasons: string[];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** True for paragraphs carrying data, concrete cases or local specifics. */
export function hasUniqueInfo(paragraph: string): boolean {
  return UNIQUE_INFO_PATTERNS.test(paragraph);
}

/**
 * True for boilerplate paragraphs: either an explicit boilerplate phrase, or
 * a very short generic paragraph with no unique information at all.
 */
export function isTemplateParagraph(paragraph: string): boolean {
  const trimmed = paragraph.trim();
  if (trimmed === '') return false; // blank lines are excluded from the ratio
  if (BOILERPLATE_PATTERNS.test(trimmed)) return true;
  return trimmed.length < 60 && !hasUniqueInfo(trimmed);
}

export function evaluateValue(input: ValueInput): ValueBreakdown {
  const reasons: string[] = [];

  // --- Demand ---
  let demandPass: boolean;
  let demandScore: number;
  if (input.draft.taskType === 'fix') {
    const impressions = input.gscPages.reduce((sum, p) => sum + p.impressions, 0);
    demandPass = impressions >= FIX_IMPRESSIONS_MIN;
    demandScore = demandPass ? 1 : 0;
    reasons.push(
      demandPass
        ? `fix target has ${impressions} GSC impressions (>= ${FIX_IMPRESSIONS_MIN})`
        : `fix target has 0 GSC impressions; no organic demand to defend`,
    );
  } else {
    const volume = input.keywordVolume ?? 0;
    demandPass = volume >= WRITE_VOLUME_MIN;
    // Saturate at 4x baseline for a smooth 0..1 score.
    demandScore = round2(Math.min(volume / (WRITE_VOLUME_MIN * 4), 1));
    reasons.push(
      demandPass
        ? `keyword volume ${volume} >= baseline ${WRITE_VOLUME_MIN}`
        : `keyword volume ${volume} below baseline ${WRITE_VOLUME_MIN}`,
    );
  }

  // --- Non-commodity quality ---
  const body = input.draft.paragraphs.map((p) => p.trim()).filter((p) => p !== '');
  let qualityPass: boolean;
  if (body.length === 0) {
    qualityPass = false;
    reasons.push('draft has no body paragraphs');
    return {
      demandPass,
      demandScore,
      templateRatio: 1,
      uniqueInfoRatio: 0,
      qualityPass,
      reasons,
    };
  }
  const templateCount = body.filter(isTemplateParagraph).length;
  const uniqueCount = body.filter(hasUniqueInfo).length;
  const templateRatio = round2(templateCount / body.length);
  const uniqueInfoRatio = round2(uniqueCount / body.length);

  const ratioOk = templateRatio <= TEMPLATE_PARAGRAPH_RATIO_MAX;
  const uniqueOk = uniqueInfoRatio >= UNIQUE_INFO_RATIO_MIN;
  const lengthOk = body.length >= MIN_PARAGRAPHS;
  if (!ratioOk) {
    reasons.push(
      `template paragraph ratio ${templateRatio} above max ${TEMPLATE_PARAGRAPH_RATIO_MAX}`,
    );
  }
  if (!uniqueOk) {
    reasons.push(
      `unique-info ratio ${uniqueInfoRatio} below min ${UNIQUE_INFO_RATIO_MIN} (data/cases/local specifics)`,
    );
  }
  if (!lengthOk) {
    reasons.push(`draft body ${body.length} paragraphs below minimum ${MIN_PARAGRAPHS}`);
  }
  if (ratioOk && uniqueOk && lengthOk) {
    reasons.push(
      `non-commodity check passed: template=${templateRatio} unique-info=${uniqueInfoRatio}`,
    );
  }
  qualityPass = ratioOk && uniqueOk && lengthOk;

  return { demandPass, demandScore, templateRatio, uniqueInfoRatio, qualityPass, reasons };
}

export function valueGate(input: ValueInput): GateVerdict {
  const breakdown = evaluateValue(input);
  const qualityScore = round2(
    Math.max(0, 1 - breakdown.templateRatio) * 0.5 +
      Math.min(breakdown.uniqueInfoRatio / UNIQUE_INFO_RATIO_MIN, 1) * 0.5,
  );
  const pass = breakdown.demandPass && breakdown.qualityPass;
  return {
    gate: 'value',
    pass,
    score: round2(breakdown.demandScore * 0.5 + qualityScore * 0.5),
    ...(pass ? {} : { action: 'revise' as const }),
    reasons: breakdown.reasons,
  };
}

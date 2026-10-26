// Pre-PR editorial QA gates (design §6.3; task doc T-E1/T-E2/T-E3).
//
// The three gates are HARD-CODED compliance controls — there is no config
// switch to disable them (AGENTS.md hard boundary, §10 policy table):
//   intent  T-E1 — SERP top-10 morphology (encyclopedic/commercial/news/
//                  navigational/transactional) must match the intended content
//                  type; transactional/navigational mismatch is discarded.
//   dedupe  T-E2 — proposed slug/title vs GSC top-20 pages, already-open PRs
//                  and published content; a query already covered by a top-10
//                  page becomes a fix candidate (or is discarded), never a new
//                  page.
//   value   T-E3 — demand exists (SERP volume for write, GSC impressions for
//                  fix) AND the draft passes the non-commodity check (bounded
//                  template-paragraph ratio, minimum unique-info share).
//
// Any failure routes drafting → qa_revision exactly once (the §3.2 state
// machine guard); a second failure after rework routes drafting → failed and
// no PR is opened.

import type { GrowthTaskType, QaResult } from '../task/types.js';
import type { SerpResult } from '../connector/serp/types.js';

/** SERP morphology classes (§6.3.1: 百科/商业/新闻 …). */
export type SerpForm =
  | 'encyclopedic'
  | 'commercial'
  | 'news'
  | 'navigational'
  | 'transactional'
  | 'mixed';

/** What the draft intends to publish. */
export type ContentKind = 'informational_article' | 'page_fix';

/** Rule-version content shape under QA review (§6.3.3). */
export interface ContentDraft {
  taskType: GrowthTaskType;
  query: string;
  /** Proposed URL path for write tasks; the existing page path for fix tasks. */
  slug: string;
  title: string;
  /** Body paragraphs (headings/lists flattened for the rule gate). */
  paragraphs: string[];
}

/** One GSC page row for the dedupe / demand gates. */
export interface GscPageEvidence {
  url: string;
  title: string;
  /** 1-based average position; lower is better. */
  position: number;
  impressions: number;
  clicks: number;
}

/** An already-open PR or published page (§6.3.2 dedupe index). */
export interface ExistingContent {
  url: string;
  title: string;
}

export interface ClassifyIntentInput {
  query: string;
  contentKind: ContentKind;
  serp: SerpResult[];
}

export interface IntentAssessment {
  /** Dominant top-10 morphology. */
  form: SerpForm;
  /** 0..1 share of top results aligned with the intended content type. */
  alignmentScore: number;
  /** Per-result morphology labels, for explainability. */
  labels: SerpForm[];
  reasons: string[];
}

/**
 * Intent classifier port. The atlas reflection adapter is a later
 * implementation; the offline rule engine (T-E1) is deterministic.
 */
export interface IntentClassifierPort {
  classify(input: ClassifyIntentInput): Promise<IntentAssessment>;
}

export type GateName = 'intent' | 'dedupe' | 'value';

/** Suggested candidate disposition when a gate fails. */
export type GateAction = 'discard' | 'convert_to_fix' | 'revise';

export interface GateVerdict {
  gate: GateName;
  pass: boolean;
  /** 0..1 explainable score (rendered in the PR body QA section). */
  score: number;
  /** Disposition suggestion when failing; absent on pass. */
  action?: GateAction;
  reasons: string[];
}

export interface QaRunReport {
  intent: GateVerdict;
  dedupe: GateVerdict;
  value: GateVerdict;
}

/** State transition the QA run requires (validated against the §3.2 machine). */
export type QaStateAction = 'pr_opened' | 'qa_revision' | 'failed';

export interface QaDecision {
  action: QaStateAction;
  /** Persisted snapshot matching growth_tasks.qa_result (§3.1). */
  qaResult: QaResult;
  report: QaRunReport;
  /** Value to persist on qa_revision_count when action=qa_revision. */
  nextRevisionCount: number;
}

export interface RunQaInput {
  draft: ContentDraft;
  /** SERP top-N snapshot for the target query. */
  serp: SerpResult[];
  /** GSC pages the site already has exposure on (query/page dimension rows). */
  gscPages: GscPageEvidence[];
  /** Max monthly volume of the seed-keyword ideas (write demand signal). */
  keywordVolume?: number;
  /** Existing open PRs (slug/title dedupe). */
  existingOpenChanges: ExistingContent[];
  /** Already-published pages (slug/title dedupe). */
  publishedContent: ExistingContent[];
  /** Persisted qa_revision_count on the task (0 on the first QA run). */
  qaRevisionCount: number;
  /** Defaults to the deterministic rule classifier (offline). */
  classifier?: IntentClassifierPort;
}

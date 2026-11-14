// Operator draft inbox (default draft source). One JSON file per task at
// <GA_DRAFT_INBOX_DIR>/<taskId>.json. Zero network and zero credentials, which
// is what makes a real dogfood run possible before any BYOK key exists.
//
// The file is validated structurally HERE rather than left to the QA gates:
// §3.2 allows exactly one qa_revision rework before a task fails terminally,
// so a missing paragraph or an empty slug must not be allowed to consume that
// single rework. Quality judgement (intent / dedupe / value) stays with the
// gates.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MIN_PARAGRAPHS } from '../qa/value-gate.js';
import type { DraftOutcome, DraftProvider, DraftRequest } from './types.js';

/** On-disk shape of one inbox file. */
export interface InboxDraftFile {
  /** Proposed URL path (write) or the existing page path (fix). */
  slug: string;
  title: string;
  paragraphs: string[];
  /** Short human-readable summary used in the PR body. */
  changeSummary: string;
  /** loom mode only: the operator-issued FCW final_id. */
  finalId?: string | undefined;
  /** loom auto-issue: FCW assemble material (POST /api/fcw/assemble). */
  productSpaceId?: string | undefined;
  platform?: string | undefined;
  slotId?: string | undefined;
  goal?: string | undefined;
  country?: string | undefined;
  pwsId?: string | undefined;
}

export type InboxFileResult =
  | { status: 'ok'; file: InboxDraftFile }
  | { status: 'missing'; reason: string }
  | { status: 'invalid'; reason: string };

export interface ReadInboxOptions {
  /**
   * False for loom mode, where the article body comes from loom and the file
   * only carries the envelope (slug / title / changeSummary / finalId).
   * Defaults to true.
   */
  requireParagraphs?: boolean;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** Optional string envelope field: undefined when absent, empty, or wrong type. */
function readOptionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return isString(value) && value.trim() !== '' ? value.trim() : undefined;
}

/** Read and structurally validate one task's inbox file. */
export function readInboxFile(
  dir: string,
  taskId: string,
  options: ReadInboxOptions = {},
): InboxFileResult {
  const requireParagraphs = options.requireParagraphs ?? true;
  const path = join(dir, `${taskId}.json`);
  if (!existsSync(path)) {
    return { status: 'missing', reason: `no draft file at ${path}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return {
      status: 'invalid',
      reason: `${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { status: 'invalid', reason: `${path} must contain a JSON object` };
  }

  const obj = parsed as Record<string, unknown>;
  const problems: string[] = [];

  const slug = obj.slug;
  if (!isString(slug) || slug.trim() === '') {
    problems.push('slug must be a non-empty string');
  }
  const title = obj.title;
  if (!isString(title) || title.trim() === '') {
    problems.push('title must be a non-empty string');
  }
  const changeSummary = obj.changeSummary;
  if (!isString(changeSummary) || changeSummary.trim() === '') {
    problems.push('changeSummary must be a non-empty string');
  }

  const paragraphs = obj.paragraphs;
  let body: string[] = [];
  if (!requireParagraphs) {
    if (paragraphs !== undefined && !Array.isArray(paragraphs)) {
      problems.push('paragraphs must be an array of strings when present');
    }
  } else if (!Array.isArray(paragraphs)) {
    problems.push('paragraphs must be an array of strings');
  } else {
    const bad = paragraphs.findIndex(p => !isString(p) || p.trim() === '');
    if (bad >= 0) {
      problems.push(`paragraphs[${bad}] must be a non-empty string`);
    } else if (paragraphs.length < MIN_PARAGRAPHS) {
      problems.push(
        `paragraphs has ${paragraphs.length} entries, below the value gate minimum ${MIN_PARAGRAPHS}`,
      );
    } else {
      body = (paragraphs as string[]).map(p => p.trim());
    }
  }

  if (problems.length > 0) {
    return { status: 'invalid', reason: `${path}: ${problems.join('; ')}` };
  }

  const file: InboxDraftFile = {
    slug: (slug as string).trim(),
    title: (title as string).trim(),
    paragraphs: body,
    changeSummary: (changeSummary as string).trim(),
  };
  const finalId = readOptionalString(obj, 'finalId');
  if (finalId !== undefined) file.finalId = finalId;
  file.productSpaceId = readOptionalString(obj, 'productSpaceId');
  file.platform = readOptionalString(obj, 'platform');
  file.slotId = readOptionalString(obj, 'slotId');
  file.goal = readOptionalString(obj, 'goal');
  file.country = readOptionalString(obj, 'country');
  file.pwsId = readOptionalString(obj, 'pwsId');
  return { status: 'ok', file };
}

export class InboxDraftProvider implements DraftProvider {
  readonly name = 'draft-inbox';
  readonly mode = 'inbox' as const;

  constructor(private readonly dir: string) {}

  async obtain(input: DraftRequest): Promise<DraftOutcome> {
    const result = readInboxFile(this.dir, input.taskId);
    if (result.status === 'missing') {
      return { status: 'unavailable', reason: result.reason };
    }
    if (result.status === 'invalid') {
      return { status: 'unavailable', reason: result.reason };
    }

    const { file } = result;
    return {
      status: 'ready',
      draft: {
        taskType: input.taskType,
        query: input.query,
        slug: file.slug,
        title: file.title,
        paragraphs: file.paragraphs,
      },
      changeSummary: file.changeSummary,
    };
  }
}

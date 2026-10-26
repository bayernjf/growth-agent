// PR / CMS-draft body template (design §4.3 + §10 compliance). The body MUST
// always contain, in fixed sections:
//   1. the target query this change serves;
//   2. GSC / SERP evidence backing the decision;
//   3. the three QA gate scores (intent / dedupe / value);
//   4. an explicit "do not auto-merge" notice — the human merge is the only
//      exit from the compliance gate (D2 human review, no auto-publish path).

export interface PrBodyInput {
  query: string;
  changeSummary: string;
  /** Preformatted evidence blocks; omitted blocks render as "none". */
  gscEvidence?: string | undefined;
  serpEvidence?: string | undefined;
  /** QA gate scores, 0..1 each (T-E1/E2/E3 produce these). */
  qaScores: { intent: number; dedupe: number; value: number };
  /** e.g. gt_2026-10-26_site-audit-checklist. */
  taskId: string;
}

export const DO_NOT_AUTO_MERGE_LINE =
  '**Do not auto-merge.** Growth-agent opens this change only; the site owner performs the final review and merge (D2 human gate, no automated publish path).';

function scoreLine(label: string, value: number): string {
  return `- ${label}: ${value.toFixed(2)}`;
}

export function buildPrBody(input: PrBodyInput): string {
  const lines: string[] = [
    `## Growth-agent change for: ${input.query}`,
    '',
    `Task: \`${input.taskId}\``,
    '',
    '### What changes',
    input.changeSummary,
    '',
    '### Evidence',
    `**GSC read-only snapshot** (${formatEvidence(input.gscEvidence)})`,
    `**SERP keyword data** (${formatEvidence(input.serpEvidence)})`,
    '',
    '### QA gate scores (must all pass before human merge)',
    scoreLine('intent', input.qaScores.intent),
    scoreLine('dedupe', input.qaScores.dedupe),
    scoreLine('value', input.qaScores.value),
    '',
    DO_NOT_AUTO_MERGE_LINE,
    '',
    '_Opened by growth-agent (BYOK, self-hosted). Data sources: your own Google Search Console (read-only scope) and your own SERP provider account._',
  ];
  return `${lines.join('\n')}\n`;
}

function formatEvidence(text: string | undefined): string {
  return text === undefined || text === '' ? 'none this run' : text;
}

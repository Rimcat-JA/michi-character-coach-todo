/** Offline evaluation scoring for detection runs (N04-G5). Pure functions only:
 * no model calls, no network, no IndexedDB. The runner (scripts/detection-eval.mjs)
 * records verbatim outputs; these functions score them deterministically. */

export type EvalExpected = { actions: string[]; mustNotCreate: boolean };
export type EvalSpan = { spanId: string; text: string };
export type EvalOutputChange = { action: string; evidence: { spanId: string; quote: string }[] };
export type EvalOutput = { changes: EvalOutputChange[] } | null;

export type EvalScored = {
  caseId: string; empty: boolean; created: boolean; forbiddenGeneration: boolean;
  fabricatedSource: boolean; criticalMisregistration: boolean; actionMatch: boolean;
};

/** One regression case, judged against the designer's expectation and the spans actually sent. */
export function scoreCase(caseId: string, expected: EvalExpected, output: EvalOutput, spans: EvalSpan[]): EvalScored {
  const changes = output?.changes ?? [];
  const empty = changes.length === 0;
  const created = changes.some(change => change.action === 'create');
  const forbiddenGeneration = expected.mustNotCreate && created;
  const fabricatedSource = changes.some(change => !change.evidence.length || change.evidence.some(reference => {
    const span = spans.find(item => item.spanId === reference.spanId);
    if (!span) return true;
    const quote = reference.quote.trim();
    return !quote.length || !span.text.includes(quote);
  }));
  // The dangerous combination: a forbidden task built on invented evidence.
  const criticalMisregistration = forbiddenGeneration && fabricatedSource;
  const actionMatch = !empty && JSON.stringify(changes.map(change => change.action).sort()) === JSON.stringify([...expected.actions].sort());
  return { caseId, empty, created, forbiddenGeneration, fabricatedSource, criticalMisregistration, actionMatch };
}

const wilson = (made: number, total: number): [number, number] => {
  if (total <= 0) return [0, 0];
  const z = 1.96, center = (made + (z * z) / 2) / (total + z * z);
  const half = (z / (total + z * z)) * Math.sqrt(made * (total - made) / total + (z * z) / 4);
  return [Math.max(0, center - half), Math.min(1, center + half)];
};

export type EvalGateMeta = {
  iterations: number; independentVerifier: boolean; blindHoldout: boolean; doubleAnnotated: boolean;
  regressionCases: number; holdoutCases: number; holdoutNegative: number; holdoutPositive: number;
};
export type EvalAggregate = {
  cases: number; emptyRate: number; precision: number; precisionCI: [number, number];
  recall: number; recallCI: [number, number]; holdoutRate: number;
  forbiddenGenerations: number; fabricatedSources: number; criticalMisregistrations: number;
  gate: { pass: boolean; reasons: string[] };
};

/** Aggregate scored cases and judge the 25.5/10.8(g) promotion gate. review-only stays regardless. */
export function aggregate(items: { expected: EvalExpected; scored: EvalScored }[], meta: EvalGateMeta): EvalAggregate {
  const scored = items.map(item => item.scored);
  const created = scored.filter(item => item.created);
  const matched = created.filter(item => item.actionMatch && !item.fabricatedSource);
  const shouldCreate = items.filter(item => !item.expected.mustNotCreate);
  const recalled = shouldCreate.filter(item => !item.scored.empty && item.scored.actionMatch && !item.scored.fabricatedSource);
  const precision = created.length ? matched.length / created.length : 1;
  const recall = shouldCreate.length ? recalled.length / shouldCreate.length : 0;
  const reasons: string[] = [];
  const counts = new Map<string, number>();
  for (const row of scored) counts.set(row.caseId, (counts.get(row.caseId) ?? 0) + 1);
  if (![meta.iterations, meta.regressionCases, meta.holdoutCases, meta.holdoutNegative, meta.holdoutPositive].every(value => Number.isSafeInteger(value) && value >= 0) || meta.holdoutNegative + meta.holdoutPositive > meta.holdoutCases) reasons.push('評価件数の申告が不正です');
  if (counts.size < meta.regressionCases + meta.holdoutCases || [...counts.values()].some(count => count < meta.iterations)) reasons.push('申告した例数・反復数に対応する採点記録がありません');
  if (!meta.independentVerifier) reasons.push('独立した検証モデルを使っていません');
  if (meta.iterations < 3) reasons.push('反復が3回未満です');
  if (scored.some(item => item.forbiddenGeneration)) reasons.push('回帰セットで禁止生成があります');
  if (scored.some(item => item.fabricatedSource)) reasons.push('架空出典があります');
  if (!meta.blindHoldout) reasons.push('blind holdoutがありません');
  if (meta.regressionCases + meta.holdoutCases < 200) reasons.push('200例未満です');
  if (meta.holdoutNegative < 100) reasons.push('陰性・境界例が100未満です');
  if (meta.holdoutPositive < 100) reasons.push('陽性・変更例が100未満です');
  if (!meta.doubleAnnotated) reasons.push('二重注釈がありません');
  if (scored.some(item => item.criticalMisregistration)) reasons.push('重大誤登録があります');
  if (precision < 0.99) reasons.push(`precision ${precision.toFixed(3)} が0.99未満です`);
  if (recall < 0.9) reasons.push(`recall ${recall.toFixed(3)} が0.90未満です`);
  return {
    cases: scored.length, emptyRate: scored.length ? scored.filter(item => item.empty).length / scored.length : 0,
    precision, precisionCI: wilson(matched.length, created.length),
    recall, recallCI: wilson(recalled.length, shouldCreate.length),
    holdoutRate: scored.length ? meta.holdoutCases / Math.max(1, meta.regressionCases + meta.holdoutCases) : 0,
    forbiddenGenerations: scored.filter(item => item.forbiddenGeneration).length,
    fabricatedSources: scored.filter(item => item.fabricatedSource).length,
    criticalMisregistrations: scored.filter(item => item.criticalMisregistration).length,
    gate: { pass: reasons.length === 0, reasons },
  };
}

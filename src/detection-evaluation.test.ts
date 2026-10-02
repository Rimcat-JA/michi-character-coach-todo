import { describe, expect, it } from 'vitest';
import { aggregate, scoreCase, type EvalExpected, type EvalOutput, type EvalSpan } from './detection-evaluation';

const spans: EvalSpan[] = [{ spanId: 's:0', text: '開発部の全員は2026年10月20日までに勤怠を提出すること' }];
const good: EvalOutput = { changes: [{ action: 'create', evidence: [{ spanId: 's:0', quote: '勤怠を提出すること' }] }] };
const expected: EvalExpected = { actions: ['create'], mustNotCreate: false };
const meta = (over: Partial<Parameters<typeof aggregate>[1]> = {}) => ({
  iterations: 3, independentVerifier: true, blindHoldout: true, doubleAnnotated: true,
  regressionCases: 100, holdoutCases: 100, holdoutNegative: 100, holdoutPositive: 100, ...over,
});
const item = (scored: ReturnType<typeof scoreCase>, mustNotCreate = false) => ({ expected: { ...expected, mustNotCreate }, scored });

describe('N04 evaluation gate (offline scoring, no model calls)', () => {
  it('missing quotes, duplicate creates and inflated case/iteration declarations cannot pass', () => {
    for (const evidence of [[], [{ spanId: 's:0', quote: ' ' }]]) expect(scoreCase('missing', expected, { changes: [{ action: 'create', evidence }] }, spans).fabricatedSource).toBe(true);
    expect(scoreCase('duplicate', expected, { changes: [...good!.changes, ...good!.changes] }, spans).actionMatch).toBe(false);
    const result = aggregate([item(scoreCase('one', expected, good, spans))], meta({ holdoutCases: 200 }));
    expect(result.gate.pass).toBe(false);
    expect(result.gate.reasons).toContain('申告した例数・反復数に対応する採点記録がありません');
  });
  it('an oracle model meets the regression metrics but fails the gate without a blind holdout', () => {
    const scored = [scoreCase('DET-001', expected, good, spans)];
    expect(scored[0]).toMatchObject({ empty: false, forbiddenGeneration: false, fabricatedSource: false, actionMatch: true });
    const full = aggregate([item(scored[0])], meta({ blindHoldout: false, regressionCases: 1, holdoutCases: 0, holdoutNegative: 0, holdoutPositive: 0 }));
    expect(full.precision).toBe(1);
    expect(full.gate.pass).toBe(false);
    expect(full.gate.reasons).toContain('blind holdoutがありません');
  });

  it('a model answering nothing fails on recall', () => {
    const scored = [scoreCase('DET-001', expected, { changes: [] }, spans), scoreCase('DET-002', expected, null, spans)];
    const full = aggregate(scored.map(s => item(s)), meta({ regressionCases: 2, holdoutCases: 0, holdoutNegative: 0, holdoutPositive: 0 }));
    expect(full.recall).toBe(0);
    expect(full.gate.pass).toBe(false);
    expect(full.gate.reasons.some(r => r.includes('recall'))).toBe(true);
  });

  it('an overproducing model fails on forbidden generation', () => {
    const scored = scoreCase('DET-016', { actions: [], mustNotCreate: true }, good, spans);
    expect(scored).toMatchObject({ forbiddenGeneration: true });
    const full = aggregate([item(scored, true)], meta({ regressionCases: 1, holdoutCases: 0, holdoutNegative: 0, holdoutPositive: 0 }));
    expect(full.gate.reasons).toContain('回帰セットで禁止生成があります');
  });

  it('a model inventing quotes fails on fabricated sources', () => {
    const invented: EvalOutput = { changes: [{ action: 'create', evidence: [{ spanId: 's:0', quote: '存在しない作業をすること' }] }] };
    const scored = scoreCase('DET-001', expected, invented, spans);
    expect(scored).toMatchObject({ fabricatedSource: true, actionMatch: true });
    const full = aggregate([item(scored)], meta({ regressionCases: 1, holdoutCases: 0, holdoutNegative: 0, holdoutPositive: 0 }));
    expect(full.gate.reasons).toContain('架空出典があります');
  });

  it('a forbidden task built on invented evidence is a critical misregistration', () => {
    const invented: EvalOutput = { changes: [{ action: 'create', evidence: [{ spanId: 'nope', quote: '捏造' }] }] };
    const scored = scoreCase('DET-016', { actions: [], mustNotCreate: true }, invented, spans);
    expect(scored).toMatchObject({ forbiddenGeneration: true, fabricatedSource: true, criticalMisregistration: true });
  });

  it('Wilson intervals stay inside [0,1] and shrink with more cases', () => {
    const one = aggregate([item(scoreCase('a', expected, good, spans))], meta({ blindHoldout: false, regressionCases: 1, holdoutCases: 0, holdoutNegative: 0, holdoutPositive: 0 }));
    const many = aggregate(Array.from({ length: 50 }, (_, n) => item(scoreCase(`c${n}`, expected, good, spans))), meta({ blindHoldout: false, regressionCases: 50, holdoutCases: 0, holdoutNegative: 0, holdoutPositive: 0 }));
    for (const ci of [one.precisionCI, one.recallCI, many.precisionCI, many.recallCI]) { expect(ci[0]).toBeGreaterThanOrEqual(0); expect(ci[1]).toBeLessThanOrEqual(1); expect(ci[0]).toBeLessThanOrEqual(ci[1]); }
    expect(many.precisionCI[1] - many.precisionCI[0]).toBeLessThan(one.precisionCI[1] - one.precisionCI[0]);
  });
});

import { expect, it } from 'vitest'
import ledger from '../docs/n11-acceptance.json'

const ids = Array.from({ length: 40 }, (_, i) => `AT-N11-${String(i + 1).padStart(2, '0')}`)
const allowed = new Set([
  'executed_app_windows',
  'executed_synthetic_host',
  'executed_unit',
  'not_implemented',
  'not_executed_real_host_required',
  'not_applicable_standalone',
])

it('every AT-N11-01..40 has a ledger entry with evidence or an explicit reason', () => {
  expect(ledger.cases).toHaveLength(40)
  expect(new Set(ledger.cases.map((row) => row.id))).toEqual(new Set(ids))
  for (const row of ledger.cases as { id: string; title: string; status: string; evidence: string[]; note: string }[]) {
    expect(allowed.has(row.status), row.id).toBe(true)
    expect(typeof row.title === 'string' && row.title.length > 0, row.id).toBe(true)
    if (row.status.startsWith('executed_')) {
      expect(Array.isArray(row.evidence) && row.evidence.length > 0, row.id).toBe(true)
    } else {
      expect(typeof row.note === 'string' && row.note.length > 0, row.id).toBe(true)
    }
  }
})

it('real-host scenarios are never marked passed on local mocks', () => {
  for (const id of ['AT-N11-38', 'AT-N11-39']) {
    const row = ledger.cases.find((entry) => entry.id === id)!
    expect(row.status).toBe('not_executed_real_host_required')
  }
})

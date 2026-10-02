import { mergeCoverage } from './coverage'
import { db } from './db'
import { spanLocation } from './source-library'
import type { ChatSourceRef } from './chat-history'

export type CoachCoverageCard = { origin: 'template'; text: string; warning: boolean }
/** Deterministic card, separately labelled from the model's unmodified answer. */
export async function coachCoverageCard(refs: ChatSourceRef[], answer: string): Promise<CoachCoverageCard | undefined> {
  const rows: { sourceId: string; conversation: string | null; provider: string; title: string; fromDate: string; toDate: string; quote: string; revision: number; location: string | null; unread: number }[] = []
  for (const ref of refs.filter(item => item.kind === 'library')) {
    const source = await db.contextSources.get(ref.id), snapshot = await db.contextSnapshots.get(`${ref.id}:${ref.revision}`)
    if (!source || !snapshot) continue
    const span = snapshot.spans.find(item => item.text.trim())
    rows.push({ sourceId: source.id, conversation: source.conversation, provider: source.provider, title: source.title, ...source.coverage, quote: span?.text.slice(0, 200) ?? '', revision: ref.revision, location: span ? spanLocation(snapshot, span.id) : null, unread: snapshot.document?.unread.length ?? 0 })
  }
  if (!rows.length) return undefined
  const groups = new Map<string, typeof rows>()
  for (const row of rows) { const key = JSON.stringify([row.provider, row.conversation ?? row.sourceId]); groups.set(key, [...(groups.get(key) ?? []), row]) }
  const segments = [...groups.values()].map(group => {
    const coverage = mergeCoverage(group)
    return `${group[0].conversation ?? group[0].title}: 取得範囲 ${coverage.segments.map(range => `${range.fromDate}〜${range.toDate}`).join('、')}${coverage.gaps.length ? ` / 欠落期間 ${coverage.gaps.map(range => `${range.fromDate}〜${range.toDate}`).join('、')}` : ''}`
  })
  const warning = /全履歴|すべて確認|一切(?:ない|ありません)|依頼はありません/.test(answer)
  return { origin: 'template', warning, text: ['本人が選んだ資料の取得範囲（端末内で計算・完全な履歴ではありません）', ...segments, '範囲外・欠落期間・未読箇所は未取得・未確認です。依頼がないとは断定できません。', ...rows.map(row => `${row.title} / ${row.sourceId} 内容版${row.revision}${row.location ? ` / ${row.location}` : ''}${row.unread ? ` / 未読${row.unread}箇所` : ''}\n選択資料の引用（先頭200文字）：${row.quote}`)].join('\n').slice(0, 10000) }
}

import { describe, expect, it } from 'vitest'
import { acceptTitleQuote, draftFromText } from './task-assist'

describe('タスク入力補助の確定境界', () => {
  it('本人の25ptと明示された期限だけを使い、移動込み時間を作業時間にしない', () => {
    const result = draftFromText('明日までに図書館へ返却。25pt、移動込み45分', '2026-09-29')
    expect(result.input).toMatchObject({ dueDate: '2026-09-30', scheduledDate: null, score: { mode: 'manual', manualPoints: 25, minutes: null } })
    expect(result.notices).toContain('所要時間の内訳が不明です。作業時間を確認してください。')
  })

  it('値が書かれていない場合と曖昧な日付は未設定のままにする', () => {
    const result = draftFromText('明日、図書館へ返却', '2026-09-29')
    expect(result.input).toMatchObject({ scheduledDate: null, dueDate: null, score: { mode: 'unset', manualPoints: null } })
    expect(result.notices.some(text => text.includes('日付の意味が曖昧'))).toBe(true)
  })

  it('点数が複数あれば選ばず、原文は下書きに残す', () => {
    const raw = 'Aは25pt、Bは40pt'
    const result = draftFromText(raw, '2026-09-29')
    expect(result.input.title).toBe(raw)
    expect(result.input.score.manualPoints).toBeNull()
  })

  it('Quick Add表記のptと、重なる期限表現も原文どおりに読む', () => {
    const result = draftFromText('期限明日までに返却 pt:25', '2026-09-29')
    expect(result.input).toMatchObject({ dueDate: '2026-09-30', score: { mode: 'manual', manualPoints: 25 } })
  })

  it('AIが追加した作業・日付・点数を受け入れず、原文にあるタイトルだけ採用する', () => {
    const raw = '明日までに図書館へ返却。25pt'
    expect(acceptTitleQuote(raw, '{"title_quote":"図書館へ返却"}')).toBe('図書館へ返却')
    expect(() => acceptTitleQuote(raw, '{"title_quote":"図書館へ返却して掃除する"}')).toThrow('原文と一致')
    expect(() => acceptTitleQuote(raw, '{"title_quote":"図書館へ返却","dueDate":"2026-09-30"}')).toThrow('形式')
    expect(() => acceptTitleQuote(raw, '掃除する')).toThrow('読めません')
  })
})

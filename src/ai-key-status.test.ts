import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { keyStatusForSave, keyStatusOnOpen } from './ai-key-status'
import FeatureConnectionsView from './FeatureConnectionsView'
import type { Settings } from './domain'

const settings: Settings = { id: 'main', profileId: 'owner', datasetId: 'dataset', createdAt: '2026-10-01T00:00:00.000Z', coachName: 'コーチ', dailyMinutes: 480, dailyPoints: 100, notifications: false, aiEnabled: false, aiModel: 'synthetic/model', automation: 'A1', lastBackupAt: null }
describe('QA: AIがOFFの間は画面を開いても保存済みキー（michi:ai-status）を読まない', () => {
  it('AI OFFでは状態取得を呼ばず、ONのときだけ呼ぶ', async () => {
    const status = vi.fn(async () => ({ secureStorage: true, configured: true }))
    expect(keyStatusOnOpen(false, status)).toBeNull()
    expect(status).not.toHaveBeenCalled()
    await expect(keyStatusOnOpen(true, status)).resolves.toEqual({ secureStorage: true, configured: true })
    expect(status).toHaveBeenCalledOnce()
    expect(keyStatusOnOpen(true, undefined)).toBeNull()
  })
  it('AI OFFで状態未確認でも、保存済みキーがあればモデルだけの保存でキーを求めない（保存ボタンの操作時にだけ状態を読む）', async () => {
    const stored = vi.fn(async () => ({ secureStorage: true, configured: true }))
    await expect(keyStatusForSave(null, '', stored)).resolves.toEqual({ secureStorage: true, configured: true })
    expect(stored).toHaveBeenCalledOnce()
    const none = vi.fn(async () => ({ secureStorage: true, configured: false }))
    await expect(keyStatusForSave(null, '', none)).rejects.toThrow('APIキーを入力してください')
    await expect(keyStatusForSave(null, 'synthetic-key', none)).resolves.toMatchObject({ configured: false })
    const unused = vi.fn(async () => ({ secureStorage: true, configured: false }))
    await expect(keyStatusForSave({ secureStorage: true, configured: true }, '', unused)).resolves.toMatchObject({ configured: true })
    expect(unused).not.toHaveBeenCalled()
  })
  it('接続一覧はAI OFFのとき「読み込んでいません」と表示し、キーなしと断定しない', () => {
    const html = renderToStaticMarkup(createElement(FeatureConnectionsView, { settings, taskCount: 0, gateways: {}, aiStatus: null }))
    expect(html).toContain('AIがOFFのため保存済みキーは読み込んでいません'); expect(html).not.toContain('APIキーなし')
  })
})

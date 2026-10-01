import { describe, expect, it, vi } from 'vitest'
import { checkGitHubStatus, localGitHubStatus, missingGitHubStatus } from './achievements-status'
import type { GitHubAchievementsGateway, GitHubGatewayStatus } from './github-publish-types'

// Synthetic gateway: the live status stands in for the main-process call that would reach api.github.com.
function gateway() {
  const stored: GitHubGatewayStatus = { state: 'awaiting_connection', configurationId: 'synthetic', authorizationRevision: 1, repository: null, notice: '保存済みの接続があります' }
  const status = vi.fn(async (): Promise<GitHubGatewayStatus> => ({ ...stored, state: 'ready' })), storedStatus = vi.fn(async () => stored)
  return { api: { status, storedStatus } as unknown as GitHubAchievementsGateway, status, storedStatus }
}
const click = (trusted: boolean) => { const event = new Event('click'); if (trusted) Object.defineProperty(event, 'isTrusted', { value: true }); return event }

describe('N10 実績画面のGitHub状態確認は本人の操作時だけ', () => {
  it('画面を開いたときは保存済みの接続だけを読み、GitHubへの状態確認を呼ばない', async () => {
    const { api, status, storedStatus } = gateway()
    expect((await localGitHubStatus(api)).state).toBe('awaiting_connection')
    expect(storedStatus).toHaveBeenCalledTimes(1)
    expect(status).not.toHaveBeenCalled()
    expect(await localGitHubStatus(undefined)).toEqual(missingGitHubStatus)
  })
  it('確認ボタンの本人のクリックでだけ状態確認を呼び、合成イベントでは呼ばない', async () => {
    const { api, status } = gateway()
    await expect(checkGitHubStatus(api, click(false))).rejects.toThrow('本人確認ボタン')
    await expect(checkGitHubStatus(api, new Event('focus'))).rejects.toThrow('本人確認ボタン')
    expect(status).not.toHaveBeenCalled()
    expect((await checkGitHubStatus(api, click(true))).state).toBe('ready')
    expect(status).toHaveBeenCalledTimes(1)
  })
})

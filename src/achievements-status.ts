import type { GitHubAchievementsGateway, GitHubGatewayStatus } from './github-publish-types'

export const missingGitHubStatus: GitHubGatewayStatus = { state: 'integration_not_configured', configurationId: null, authorizationRevision: 0, repository: null, notice: '実績用GitHub接続は未設定です。開発用のGitHub認証は使いません。' }
export function assertNativeEvent(event: Event) { if (!event.isTrusted || !['click', 'submit'].includes(event.type)) throw new Error('本人確認ボタンから操作してください') }
/** Opening the screen reads only what is stored on this PC; GitHub is contacted only from the owner's check button. */
export const localGitHubStatus = (api: GitHubAchievementsGateway | undefined): Promise<GitHubGatewayStatus> => api ? api.storedStatus() : Promise.resolve(missingGitHubStatus)
export async function checkGitHubStatus(api: GitHubAchievementsGateway | undefined, event: Event): Promise<GitHubGatewayStatus> {
  assertNativeEvent(event)
  return api ? api.status() : missingGitHubStatus
}

import { readCoachConversation, saveCoachDraft } from './chat-history'

export const AI_OFFLINE_MESSAGE = 'AIはオフラインのため利用できません'
export const AI_OFFLINE_NOTICE = `${AI_OFFLINE_MESSAGE}。入力は下書きとして保存しました。通信が戻っても自動では送信しません。`
/** 18.7: with only an external model and no network, the turn is not started. The draft is kept,
 * and no reply row (live_ai, template or notice) is written. */
export async function holdCoachDraftOffline(conversationId: string, text: string): Promise<string> {
  const current = await readCoachConversation(conversationId)
  if (current.conversation.draft !== text) await saveCoachDraft(conversationId, current.conversation.draftRevision, text)
  return AI_OFFLINE_NOTICE
}

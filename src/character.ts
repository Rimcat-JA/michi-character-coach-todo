import { db } from './db'
import type { CharacterProfile } from './domain'

export const DEFAULT_CHARACTER: CharacterProfile = { pronoun: '私', tone: 'gentle', detail: 'standard', coachingStyle: 'encouraging', avoidPhrases: [] }

export function validateCharacterProfile(value: CharacterProfile) {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 5 || Object.keys(DEFAULT_CHARACTER).some(key => !Object.hasOwn(value, key)) || !['私', '僕', 'わたし'].includes(value.pronoun) || !['gentle', 'direct', 'playful'].includes(value.tone) || !['brief', 'standard', 'thorough'].includes(value.detail) || !['encouraging', 'practical', 'reflective'].includes(value.coachingStyle) || !Array.isArray(value.avoidPhrases) || value.avoidPhrases.length > 10 || new Set(value.avoidPhrases).size !== value.avoidPhrases.length || value.avoidPhrases.some(phrase => typeof phrase !== 'string' || !phrase.trim() || phrase.length > 40)) throw new Error('キャラクター設定が不正です')
}

export async function saveCharacterProfile(patch: Partial<CharacterProfile>) {
  await db.transaction('rw', db.settings, async () => {
    const settings = await db.settings.get('main'); if (!settings) throw new Error('設定がありません')
    const characterProfile = { ...DEFAULT_CHARACTER, ...settings.characterProfile, ...patch }
    validateCharacterProfile(characterProfile)
    await db.settings.update('main', { characterProfile })
  })
}

export function characterizeAnswer(text: string, character: CharacterProfile = DEFAULT_CHARACTER) {
  validateCharacterProfile(character)
  const lead = character.tone === 'direct' ? '要点から整理します。' : character.tone === 'playful' ? 'ひとつずつ進めよう。' : ''
  const style = character.coachingStyle === 'practical' ? '次にできる操作を確認しましょう。' : character.coachingStyle === 'reflective' ? '今の状況を一緒に確かめましょう。' : ''
  let answer = `${lead}${text}${style}`
  if (character.detail === 'brief' && answer.length > 140) answer = `${answer.slice(0, 137)}…`
  for (const phrase of character.avoidPhrases) answer = answer.split(phrase).join('')
  return answer
}


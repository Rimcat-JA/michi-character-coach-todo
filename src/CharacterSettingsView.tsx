import { useState } from 'react'
import type { Settings } from './domain'
import { DEFAULT_CHARACTER, characterizeAnswer, saveCharacterProfile } from './character'

export default function CharacterSettingsView({ settings, run }: { settings: Settings; run: (fn: () => Promise<unknown>, success?: string) => Promise<boolean> }) {
  const profile = settings.characterProfile ?? DEFAULT_CHARACTER
  const [avoidDraft, setAvoidDraft] = useState(profile.avoidPhrases.join('、'))
  return <section className="card setting-section character-settings"><div className="setting-heading"><div><h2>コーチのキャラクター</h2><p>会話の表現だけに適用します。通知頻度・権限・ポイントはここでは変わりません。</p></div></div><div className="form-grid">
    <label className="field">一人称<select value={profile.pronoun} onChange={event => run(() => saveCharacterProfile({ pronoun: event.target.value as typeof profile.pronoun }), 'キャラクターを保存しました')}><option>私</option><option>僕</option><option>わたし</option></select></label>
    <label className="field">口調<select value={profile.tone} onChange={event => run(() => saveCharacterProfile({ tone: event.target.value as typeof profile.tone }), 'キャラクターを保存しました')}><option value="gentle">やさしく</option><option value="direct">率直に</option><option value="playful">明るく</option></select></label>
    <label className="field">説明の長さ<select value={profile.detail} onChange={event => run(() => saveCharacterProfile({ detail: event.target.value as typeof profile.detail }), 'キャラクターを保存しました')}><option value="brief">短く</option><option value="standard">標準</option><option value="thorough">詳しく</option></select></label>
    <label className="field">指導スタイル<select value={profile.coachingStyle} onChange={event => run(() => saveCharacterProfile({ coachingStyle: event.target.value as typeof profile.coachingStyle }), 'キャラクターを保存しました')}><option value="encouraging">励ます</option><option value="practical">実行を整理</option><option value="reflective">振り返る</option></select></label>
    <label className="field full-field">避ける言い方（読点で区切る）<input value={avoidDraft} maxLength={400} onChange={event => setAvoidDraft(event.target.value)} placeholder="例：急いで、頑張れ" /></label>
  </div><button className="secondary-button" onClick={() => run(() => saveCharacterProfile({ avoidPhrases: avoidDraft.split('、').map(value => value.trim()).filter(Boolean) }), '避ける言い方を保存しました')}>避ける言い方を保存</button><p className="muted character-preview">表示例：{characterizeAnswer('登録済みのタスクから次の一歩を選べます。', profile)}</p></section>
}

import { useEffect, useState } from 'react'
import { CoachAvatarView } from './CoachAvatarView'
import { getBrowserVoiceMediaController } from './voice-media'
import type { AvatarMode } from './avatar-media'

/** The hidden flag is the persisted H01 'avatar' feature; the panel only displays it. */
export default function CoachAvatarPanel({ name, thinking, hidden, onHiddenChange }: { name: string; thinking: boolean; hidden: boolean; onHiddenChange: (hidden: boolean) => void }) {
  const [mode, setMode] = useState<AvatarMode>('idle')
  useEffect(() => getBrowserVoiceMediaController().subscribe(state => {
    setMode(state.speech === 'speaking' ? 'speaking' : state.input === 'recording' ? 'listening' : 'idle')
  }), [])
  return <CoachAvatarView name={name} mode={mode === 'idle' && thinking ? 'thinking' : mode} hidden={hidden} onHiddenChange={onHiddenChange} />
}

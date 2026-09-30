import { useEffect, useState } from 'react'
import { CoachAvatarView } from './CoachAvatarView'
import { getBrowserVoiceMediaController } from './voice-media'
import type { AvatarMode } from './avatar-media'

export default function CoachAvatarPanel({ name, thinking }: { name: string; thinking: boolean }) {
  const [mode, setMode] = useState<AvatarMode>('idle'), [hidden, setHidden] = useState(false)
  useEffect(() => getBrowserVoiceMediaController().subscribe(state => {
    setMode(state.speech === 'speaking' ? 'speaking' : state.input === 'recording' ? 'listening' : 'idle')
  }), [])
  return <CoachAvatarView name={name} mode={mode === 'idle' && thinking ? 'thinking' : mode} hidden={hidden} onHiddenChange={setHidden} />
}

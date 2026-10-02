import { expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { VoiceMediaView } from './VoiceMediaView'
import { CoachAvatarView } from './CoachAvatarView'
import { createAvatarController, type AvatarBundle } from './avatar-media'
import { createVoiceMediaController, type MusicPort, type RecognitionAdapter, type TTSAdapter } from './voice-media'
it('synthetic voice/model failures leave static avatar, readable response and task editor controls available',async()=>{
 let input!:Parameters<RecognitionAdapter['start']>[0],speech!:Parameters<TTSAdapter['speak']>[2]
 const controller=createVoiceMediaController({music:{volume:1,src:'',play:async()=>{},pause(){},load(){},onended:null,onerror:null} as MusicPort,recognition:{local:true,available:async()=>true,start:e=>{input=e},stop(){},cancel(){}},tts:{voices:()=>[{id:'local',name:'local',lang:'ja-JP',local:true}],speak:(_text,_voice,e)=>{speech=e},cancel(){}},createURL:()=>'',revokeURL(){}})
 await controller.startInput();input.error('not-allowed');input.result('late denied transcript')
 expect(controller.snapshot().transcript).toBe('');expect(controller.snapshot().notice).toContain('マイクが許可されていません')
 const changed=vi.fn(),avatar=createAvatarController({localOnly:true,sdkRightsConfirmed:true,load:async()=>{throw Error('synthetic model load failure')}},changed)
 await avatar.load({} as HTMLCanvasElement,{rights:{ownsOrLicensed:true}} as AvatarBundle)
 expect(changed).toHaveBeenLastCalledWith({status:'static',notice:expect.stringContaining('静止キャラクター')})
 controller.speakResponse('表示した応答本文','local');speech.start();speech.error('synthetic TTS failure')
 const html=renderToStaticMarkup(<aside><p>表示した応答本文</p><CoachAvatarView/><VoiceMediaView responseText="表示した応答本文" controller={controller}/><button>タスクを編集</button><input aria-label="本人のタイトル" defaultValue="保持した下書き"/><button>保存</button></aside>)
 expect(html).toContain('同梱静止キャラクター');expect(html).toContain('応答はテキストで読めます');expect(html).toContain('保持した下書き');expect(html).toContain('<button>タスクを編集</button>');expect(html).toContain('<button>保存</button>')
 controller.dispose();avatar.dispose()
})

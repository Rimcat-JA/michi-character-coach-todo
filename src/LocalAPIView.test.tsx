import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import LocalAPIView from './LocalAPIView'
import { defaultChangePolicy } from './change-set'
import type { Settings } from './domain'
const settings={profileId:'owner',datasetId:'dataset',aiEnabled:true,changePolicy:defaultChangePolicy()} as Settings
it('PWA explains Windows API availability and explicit local reachability',()=>{
 const html=renderToStaticMarkup(<LocalAPIView settings={settings}/> )
 expect(html).toContain('Windows版');expect(html).toContain('127.0.0.1');expect(html).toContain('毎回確認')
})
it('synthetic desktop renders off-by-default API controls, readonly preset and approval inbox',()=>{
 const html=renderToStaticMarkup(<LocalAPIView settings={settings} gateway={{request:async()=>null,invalidate:async()=>{}}}/> )
 expect(html).toContain('停止中');expect(html).toContain('読取のみ');expect(html).toContain('API受信箱');expect(html).toContain('data-local-api-configure="server"');expect(html).not.toContain('michi_')
})

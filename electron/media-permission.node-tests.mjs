import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
const {createMediaPermissionPolicy}=createRequire(import.meta.url)('./media-permission.cjs')
test('microphone permits main app audio with a fresh native gesture; video and foreign/stale frames remain denied',()=>{
 let now=10000
 const frame={url:'michi://app/index.html'},contents={mainFrame:frame,isDestroyed:()=>false},policy=createMediaPermissionPolicy({getContents:()=>contents,now:()=>now})
 const request={isMainFrame:true,requestingUrl:frame.url,mediaTypes:['audio']},check={...request,mediaType:'audio'}
 assert.equal(policy.request(contents,'media',request),false)
 assert.equal(policy.grant({sender:contents,senderFrame:{url:frame.url}}),false)
 assert.equal(policy.grant({sender:contents,senderFrame:frame}),true)
 for(const value of [{...request,mediaTypes:['video']},{...request,mediaTypes:['audio','video']},{...request,isMainFrame:false},{...request,requestingUrl:'https://example.org'},{}])assert.equal(policy.request(contents,'media',value),false)
 assert.equal(policy.check(contents,'media','michi://app',check),true)
 assert.equal(policy.check(contents,'media','https://example.org',check),false)
 assert.equal(policy.check(contents,'media','michi://app',{...check,mediaType:'video'}),false)
 assert.equal(policy.request(contents,'media',request),true)
 assert.equal(policy.check(contents,'media','michi://app',check),false)
 policy.grant({sender:contents,senderFrame:frame});now+=5001
 assert.equal(policy.request(contents,'media',request),false)
 assert.equal(policy.request(contents,'geolocation',request),false)
 policy.grant({sender:contents,senderFrame:frame});frame.url='michi://app/other.html'
 assert.equal(policy.request(contents,'media',{...request,requestingUrl:frame.url}),false)
})

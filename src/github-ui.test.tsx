import 'fake-indexeddb/auto'
import {describe,expect,it} from 'vitest'
import {renderToStaticMarkup} from 'react-dom/server'
import {GitHubInitializationDetails,GitHubQAAlert} from './AchievementsView'
import AnalyticsView from './AnalyticsView'
import type {GitHubInitializationProposal} from './github-publish-types'

describe('GitHub実績の表示境界',()=>{
 it('QAの表示と初期化対象・正確なREADMEをrenderし、QAが無効ならalertを表示しない',()=>{
  expect(renderToStaticMarkup(<GitHubQAAlert active/>)).toContain('実GitHubではありません')
  expect(renderToStaticMarkup(<GitHubQAAlert active={false}/>)).toBe('')
  const proposal:GitHubInitializationProposal={reference:'fixture',digest:'a'.repeat(64),repository:{repositoryId:123,owner:'owner',name:'repo',defaultBranch:'main',visibility:'public',headSha:null,empty:true,protected:false,ownerVerified:true,canPush:true,observedAt:'2026-10-02T00:00:00.000Z'},path:'README.md',content:'# Synthetic init\nNo achievement data.\n',sha256:'b'.repeat(64),expiresAt:'2026-10-02T00:05:00.000Z'}
  const html=renderToStaticMarkup(<GitHubInitializationDetails proposal={proposal}/>)
  for(const text of ['owner/repo','全世界に公開','main','README.md',proposal.sha256,proposal.content])expect(html).toContain(text)
 })
 it('履歴のポイント図にはGitHub標準の草と別の集計であることを明記する',()=>{
  expect(renderToStaticMarkup(<AnalyticsView completions={[]} sessions={[]}/>)).toContain('アプリ内の確定ポイント。GitHub標準の草とは別の集計です')
 })
})

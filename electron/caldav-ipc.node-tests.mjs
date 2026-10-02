import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {createRequire} from 'node:module'
import {createCalDAVFixtureServer} from './fixtures/caldav-fixture-server.mjs'
const require=createRequire(import.meta.url),{installCalDAVIPC}=require('./caldav-ipc.cjs'),{createNetworkGateway}=require('./network-gateway.cjs'),{createScheduleTransport}=require('./schedule-network.cjs')
async function fixture(t){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'michi-caldav-ipc-')),remote=await createCalDAVFixtureServer();t.after(()=>remote.close());t.after(()=>fs.rm(directory,{recursive:true,force:true}));const settings={profileId:'owner',datasetId:'dataset',changePolicy:{epoch:1}},dataset={mode:'active'},state={ownerId:'owner',datasetId:'dataset',sources:[{id:'source',coverageFrom:'2026-10-01',coverageTo:'2026-10-31',ics:{components:[],retentionUntil:'2030-01-01T00:00:00.000Z'}}]},sent=[],jobs=new Map();let handler,answer=0,afterDialog=()=>{},online=true
 const options={ipcMain:{handle(_channel,value){handler=value}},dialog:{showMessageBox:async()=>{afterDialog();return {response:answer}}},win:{isDestroyed:()=>false,webContents:{send:(channel,value)=>sent.push({channel,value:structuredClone(value)})},on:()=>{}},app:{getPath:()=>directory},safeStorage:{isEncryptionAvailable:()=>true,encryptString:text=>Buffer.from(text),decryptString:bytes=>bytes.toString()},gateway:createNetworkGateway({getPolicy:async()=>({policy:online?'explicit_online':'offline_only'}),qaScheduleLoopback:true,scheduleTransport:createScheduleTransport({qaLoopback:true})}),readDatabase:async(_win,table)=>structuredClone({settings,datasetState:dataset,calendarRules:state}[table]),assertFrame:event=>{if(!event.valid)throw Error('FOREIGN_FRAME')},refreshScheduler:{getService:async()=>({addJob:(id,job)=>{jobs.set(id,job);return()=>jobs.delete(id)},start:()=>{}})},qaLoopback:true}
 const install=()=>installCalDAVIPC(options);install();const request=(value,event={valid:true})=>handler(event,value),discover=()=>request({action:'discover',url:remote.url,username:'fixture-user',password:'fixture-app-password'}),configure=async()=>{const discovery=await discover();return request({action:'configure',discoveryId:discovery.id,sourceId:'source',readCollection:remote.origin+'/calendars/read/',writeCollection:remote.origin+'/calendars/michi/',dedicatedConfirmed:true,refreshPolicy:'daily'})}
 return {directory,remote,settings,dataset,state,sent,jobs,request,discover,configure,install,setAnswer:value=>answer=value,setAfterDialog:value=>afterDialog=value,setOnline:value=>online=value}
}
test('CalDAV main rejects foreign frames, approval claims, cancellation and authority changes before any HTTP',async t=>{
 const f=await fixture(t);await assert.rejects(f.request({action:'list'},{valid:false}),/FOREIGN/);await assert.rejects(f.request({action:'discover',url:f.remote.url,username:'fixture-user',password:'fixture-app-password',approved:true}),/REQUEST_INVALID/);f.setAnswer(1);assert.equal(await f.discover(),null);assert.equal(f.remote.requests.length,0)
 f.setAnswer(0);f.setAfterDialog(()=>f.settings.changePolicy.epoch++);await assert.rejects(f.discover(),/AUTHORITY_CHANGED/);assert.equal(f.remote.requests.length,0)
})
test('CalDAV main persists no raw mirror, rehydrates pending after restart, and sweeps expired permissions before due',async t=>{
 const f=await fixture(t),record=await f.configure();await f.request({action:'sync',id:record.id});const first=await f.request({action:'candidate',id:record.id});assert.equal(first.ownerId,'owner');assert.equal(first.policyEpoch,1);assert.ok(first.bytes.length)
 const saved=JSON.parse(await fs.readFile(path.join(f.directory,'caldav-private','connections.bin'),'utf8'));assert.equal(JSON.stringify(saved).includes('BEGIN:VCALENDAR'),false);assert.equal(saved.caldav[0].pendingCandidate,undefined);assert.equal(saved.caldav[0].awaitingApproval,true)
 f.install();const second=await f.request({action:'candidate',id:record.id});assert.equal(second.bodySha256,first.bodySha256);await f.request({action:'acknowledge',id:record.id,bodySha256:second.bodySha256});assert.equal((await f.request({action:'list'}))[0].status,'current')
 f.state.sources[0].ics.retentionUntil='2020-01-01T00:00:00.000Z';const count=f.remote.requests.length;assert.equal(await f.jobs.get(record.id).sweep(),false);assert.equal(f.remote.requests.length,count);await assert.rejects(f.request({action:'candidate',id:record.id}),/PERMISSION_EXPIRED/)
})
test('CalDAV main keeps acquisition pending across a failed HTTP check and clears volatile bytes when offline',async t=>{
 const f=await fixture(t),record=await f.configure();await f.request({action:'sync',id:record.id});f.remote.setMode('busy');const failed=await f.request({action:'sync',id:record.id});assert.equal(failed.status,'stale');assert.ok(Date.parse(failed.nextDueAt)-Date.now()>119000)
 f.remote.setMode('normal');const recovered=await f.request({action:'sync',id:record.id});assert.equal(recovered.status,'pending');assert.ok(await f.request({action:'candidate',id:record.id}));f.setOnline(false);assert.equal(await f.jobs.get(record.id).sweep(),false);assert.equal((await f.request({action:'list'}))[0].status,'paused')
})

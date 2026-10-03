import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {schemaMatches} from './plugin-schema.mjs'
const catalog=createRequire(import.meta.url)('./contracts/plugin-tools.resolved.json')
const schema=name=>catalog.tools.find(tool=>tool.name===name).inputSchema
const id='123e4567-e89b-42d3-a456-426614174000'
test('vendored catalog has exactly 15 tools; resolved schemas never fetch references',()=>{
 assert.equal(catalog.tools.length,15);assert.equal(new Set(catalog.tools.map(tool=>tool.name)).size,15)
 assert.equal(JSON.stringify(catalog).includes('"$ref"'),false)
})
test('dates, safe integers, exact objects, composite constraints and unique items fail closed',()=>{
 for(const value of [{from:'2026-02-30',to:'2026-03-01'},{from:'2026-10-01',to:'2026-10-03',approved:true}])assert.equal(schemaMatches(schema('coach_get_history'),value),false)
 assert.equal(schemaMatches(schema('coach_get_history'),{from:'2026-10-01',to:'2026-10-03'}),true)
 assert.equal(schemaMatches(schema('coach_search_tasks'),{limit:51}),false)
 assert.equal(schemaMatches(schema('coach_search_tasks'),{filter:{project_ids:[id,id]}}),false)
 assert.equal(schemaMatches({type:'integer'},9007199254740992),false)
 assert.equal(schemaMatches({type:'string',format:'date-time'},'2026-02-30T12:00:00Z'),false)
 assert.equal(schemaMatches({type:'string',format:'date-time'},'2026-10-03T25:00:00Z'),false)
 assert.equal(schemaMatches({type:['string','null'],format:'uuid'},null),true)
 assert.equal(schemaMatches({$ref:'https://evil.invalid'},{}),false)
 assert.equal(schemaMatches({type:'object'},JSON.parse('{"__proto__":{}}')),false)
})
test('contract accepts zero/manual/basis references but never fake approval, actors, nested ledger or empty patches',()=>{
 const base={request_key:id,operation:'task.update',task_id:id,expected_revision:1,payload:{changes:{scheduled_date:'2026-10-04'}},basis:{kind:'external_request',note:'依頼'}}
 assert.equal(schemaMatches(schema('coach_prepare_change'),base),true)
 for(const patch of [{approved:true},{actor_id:'human'},{expected_revision:null},{request_key:'not-uuid'},{payload:{changes:{}}},{payload:{changes:{ledger_points:100}}}])assert.equal(schemaMatches(schema('coach_prepare_change'),{...base,...patch}),false)
 assert.equal(schemaMatches(schema('coach_prepare_change'),{...base,operation:'task.score.set_manual',payload:{points:0}}),true)
 assert.equal(schemaMatches(schema('coach_prepare_change'),{...base,operation:'task.score.set_manual',payload:{points:-1}}),false)
 assert.equal(schemaMatches(schema('coach_prepare_change'),{...base,basis:{kind:'app_instruction',reference_id:id}}),true)
})

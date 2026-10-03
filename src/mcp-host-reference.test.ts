import {expect,it} from 'vitest'
import {mcpHostReferences} from './mcp-host-reference'
it('PowerShell reference commands quote spaces, Japanese, apostrophes and literal shell metacharacters',()=>{
  const command="C:\\本人の資料\\O'Brien $(never-run)\\michi.exe",args=['C:\\本人の資料\\michi-mcp.mjs','--bridge','C:\\本人の資料\\接続 ID']
  const result=mcpHostReferences({mcpServers:{michi:{command,args,env:{ELECTRON_RUN_AS_NODE:'1'}}}})
  expect(result.status).toBe('reference_unverified');expect(result.codex).toContain("'C:\\本人の資料\\O''Brien $(never-run)\\michi.exe'")
  expect(result.claudeCode).toContain('--env ELECTRON_RUN_AS_NODE=1 --transport stdio michi --')
  expect(JSON.parse(result.gemini).mcpServers.michi).toEqual({command,args,env:{ELECTRON_RUN_AS_NODE:'1'},trust:false})
})

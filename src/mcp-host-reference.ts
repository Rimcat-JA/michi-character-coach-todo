type MCPConfiguration = {mcpServers:{michi:{command:string;args:string[];env:{ELECTRON_RUN_AS_NODE:'1'}}}}
const quote = (value:string) => "'"+value.replace(/'/g,"''")+"'"
/** References only: never execute these commands or label a host integration verified. */
export function mcpHostReferences(config:MCPConfiguration) {
  const entry=config.mcpServers.michi, command=[entry.command,...entry.args].map(quote).join(' ')
  return {
    checkedAt:'2026-10-03',status:'reference_unverified',
    codex:`codex mcp add michi --env ELECTRON_RUN_AS_NODE=1 -- ${command}`,
    claudeCode:`claude mcp add --env ELECTRON_RUN_AS_NODE=1 --transport stdio michi -- ${command}`,
    gemini:JSON.stringify({mcpServers:{michi:{...entry,trust:false}}},null,2),
    sources:{codex:'https://learn.chatgpt.com/docs/extend/mcp?surface=cli',claudeCode:'https://code.claude.com/docs/en/mcp',gemini:'https://geminicli.com/docs/tools/mcp-server/'}
  }
}

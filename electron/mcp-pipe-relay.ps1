param([Parameter(Mandatory=$true)][string]$PipeName)
$ErrorActionPreference = 'Stop'
if ($PipeName -notmatch '^michi-[a-f0-9]{32}$') { throw 'PIPE_NAME_INVALID' }
Add-Type -Path (Join-Path $PSScriptRoot 'mcp-pipe-relay.cs') -ReferencedAssemblies System,System.Core,System.Web.Extensions
[MichiPipeRelay]::Run($PipeName)

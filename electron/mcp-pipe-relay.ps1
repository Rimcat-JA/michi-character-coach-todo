param([Parameter(Mandatory=$true)][string]$PipeName)
$ErrorActionPreference = 'Stop'
if ($PipeName -notmatch '^michi-[a-f0-9]{32}$') { throw 'PIPE_NAME_INVALID' }
try {
  Add-Type -Path (Join-Path $PSScriptRoot 'mcp-pipe-relay.cs') -ReferencedAssemblies System,System.Core,System.Web.Extensions
  [MichiPipeRelay]::Run($PipeName)
} catch {
  # Report only bounded type/category/numeric codes, never paths or protocol text.
  $failure = $_.Exception
  while ($null -ne $failure.InnerException) { $failure = $failure.InnerException }
  $type = $failure.GetType().Name
  if ($type -notmatch '^[A-Za-z]{1,80}$') { $type = 'Exception' }
  $category = [string]$_.CategoryInfo.Category
  $compiler = [regex]::Match([string]$_.Exception.Message, '\bCS[0-9]{4}\b').Value
  [Console]::Error.WriteLine("MICHI_PIPE_STARTUP:${type}:${category}:$($failure.HResult):${compiler}")
  exit 1
}

$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$runtime = (Resolve-Path -LiteralPath (Join-Path $project 'node_modules\electron\dist')).Path
$release = Join-Path $project 'release'
New-Item -ItemType Directory -Path $release -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$destination = Join-Path $release "michi-portable-$stamp"
if (Test-Path -LiteralPath $destination) { throw 'Package destination already exists' }
Copy-Item -LiteralPath $runtime -Destination $destination -Recurse
$appFolder = Join-Path $destination 'resources\app'
New-Item -ItemType Directory -Path $appFolder -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $project 'dist') -Destination (Join-Path $appFolder 'dist') -Recurse
Copy-Item -LiteralPath (Join-Path $project 'electron') -Destination (Join-Path $appFolder 'electron') -Recurse
Copy-Item -LiteralPath (Join-Path $project 'package.json') -Destination (Join-Path $appFolder 'package.json')
Copy-Item -LiteralPath (Join-Path $project 'README.md') -Destination (Join-Path $destination 'README.txt')
Move-Item -LiteralPath (Join-Path $destination 'electron.exe') -Destination (Join-Path $destination 'michi.exe')
Write-Output "Portable app: $destination"

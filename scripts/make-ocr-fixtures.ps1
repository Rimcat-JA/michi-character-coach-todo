# One-shot fixture renderer for offline OCR evaluation (Windows, no UI shown).
# Renders general OS fonts (Arial / Yu Gothic) to 24-bit BMPs in $OutDir.
# Independent of any OCR engine's templates. Re-run to regenerate.
param([string]$OutDir = "$PSScriptRoot\..\ocr-fixture-bmp")
New-Item -ItemType Directory -Force $OutDir | Out-Null
Add-Type -AssemblyName System.Drawing

function Render-Text($File, $FontName, $Size, $Lines) {
  $font = New-Object System.Drawing.Font($FontName, $Size, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
  $probe = New-Object System.Drawing.Bitmap(8, 8)
  $g0 = [System.Drawing.Graphics]::FromImage($probe)
  $w = 0; $h = 0
  foreach ($line in $Lines) {
    $s = $g0.MeasureString($line, $font)
    if ($s.Width -gt $w) { $w = $s.Width }
    $h += $s.Height
  }
  $g0.Dispose(); $probe.Dispose()
  $W = [int]([Math]::Ceiling($w)) + 80; $H = [int]([Math]::Ceiling($h)) + 80
  $bmp = New-Object System.Drawing.Bitmap($W, $H)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::White)
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $y = 40
  foreach ($line in $Lines) {
    $g.DrawString($line, $font, [System.Drawing.Brushes]::Black, 40, $y)
    $y += $g.MeasureString($line, $font).Height
  }
  $g.Dispose(); $font.Dispose()
  $bmp.Save((Join-Path $OutDir $File), [System.Drawing.Imaging.ImageFormat]::Bmp)
  $bmp.Dispose()
  Write-Output "$File ${W}x${H}"
}

Render-Text 'ocr-en.bmp' 'Arial' 64 @('Meeting at 10:00', 'Please submit the report')
Render-Text 'ocr-ja.bmp' 'MS Gothic' 64 @('会議は10時からです', '提出してください')
Render-Text 'ocr-mixed.bmp' 'Yu Gothic' 64 @('Meeting at 10:00', '会議は10時からです')
Render-Text 'ocr-logo.bmp' 'Arial' 48 @('ACME')

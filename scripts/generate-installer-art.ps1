# Generates branded BMP / ICO assets for Hormachuelos NSIS + WiX installers.
# Run: powershell -ExecutionPolicy Bypass -File scripts/generate-installer-art.ps1

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root "src-tauri\installer"
$iconPath = Join-Path $root "src-tauri\icons\icon.png"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function New-SolidBrushColor([int]$r, [int]$g, [int]$b) {
  return New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, $r, $g, $b))
}

function Draw-Gradient([System.Drawing.Graphics]$g, [int]$w, [int]$h, [System.Drawing.Color]$c1, [System.Drawing.Color]$c2, [bool]$vertical = $true) {
  $mode = if ($vertical) {
    [System.Drawing.Drawing2D.LinearGradientMode]::Vertical
  } else {
    [System.Drawing.Drawing2D.LinearGradientMode]::Horizontal
  }
  $rect = New-Object System.Drawing.Rectangle(0, 0, [Math]::Max(1, $w), [Math]::Max(1, $h))
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $c1, $c2, $mode)
  $g.FillRectangle($brush, 0, 0, $w, $h)
  $brush.Dispose()
}

function Draw-SoftOrb([System.Drawing.Graphics]$g, [int]$cx, [int]$cy, [int]$radius, [System.Drawing.Color]$color) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddEllipse($cx - $radius, $cy - $radius, $radius * 2, $radius * 2)
  $pgb = New-Object System.Drawing.Drawing2D.PathGradientBrush $path
  $pgb.CenterColor = $color
  $pgb.SurroundColors = @([System.Drawing.Color]::FromArgb(0, $color))
  $g.FillEllipse($pgb, $cx - $radius, $cy - $radius, $radius * 2, $radius * 2)
  $pgb.Dispose()
  $path.Dispose()
}

function Save-Bmp24([System.Drawing.Bitmap]$bmp, [string]$path) {
  # NSIS/WiX prefer classic 24-bit BMP
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Bmp)
}

$logo = [System.Drawing.Image]::FromFile($iconPath)
$bgDeep = [System.Drawing.Color]::FromArgb(255, 14, 14, 16)
$bgMid = [System.Drawing.Color]::FromArgb(255, 28, 30, 36)
$accent = [System.Drawing.Color]::FromArgb(255, 90, 160, 255)
$accentSoft = [System.Drawing.Color]::FromArgb(70, 90, 160, 255)
$textMuted = [System.Drawing.Color]::FromArgb(255, 180, 190, 210)
$textBright = [System.Drawing.Color]::FromArgb(255, 245, 246, 248)

# --- NSIS sidebar (Welcome / Finish): 164 × 314 ---
$sidebar = New-Object System.Drawing.Bitmap 164, 314
$g = [System.Drawing.Graphics]::FromImage($sidebar)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
Draw-Gradient $g 164 314 $bgDeep $bgMid $true
Draw-SoftOrb $g 40 70 90 $accentSoft
Draw-SoftOrb $g 140 240 100 ([System.Drawing.Color]::FromArgb(40, 120, 200, 255))

# Logo plate
$plate = 88
$px = [int]((164 - $plate) / 2)
$py = 72
$g.FillRectangle((New-SolidBrushColor 255 255 255), $px, $py, $plate, $plate)
$g.DrawImage($logo, $px + 8, $py + 8, $plate - 16, $plate - 16)

$fontBrand = New-Object System.Drawing.Font "Segoe UI Semibold", 11, ([System.Drawing.FontStyle]::Bold)
$fontTag = New-Object System.Drawing.Font "Segoe UI", 7.5
$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = [System.Drawing.StringAlignment]::Center
$g.DrawString("HORMACHUELOS", $fontBrand, (New-Object System.Drawing.SolidBrush $textBright), (New-Object System.Drawing.RectangleF(8, 178, 148, 28)), $sf)
$g.DrawString("Pinoy-made AI`nfor builders", $fontTag, (New-Object System.Drawing.SolidBrush $textMuted), (New-Object System.Drawing.RectangleF(10, 210, 144, 48)), $sf)

# Accent line
$g.FillRectangle((New-Object System.Drawing.SolidBrush $accent), 52, 268, 60, 2)
$g.DrawString("GCash · PHP", $fontTag, (New-Object System.Drawing.SolidBrush $textMuted), (New-Object System.Drawing.RectangleF(8, 278, 148, 20)), $sf)
$g.Dispose()
Save-Bmp24 $sidebar (Join-Path $outDir "nsis-sidebar.bmp")
$sidebar.Dispose()

# --- NSIS header: 150 × 57 ---
$header = New-Object System.Drawing.Bitmap 150, 57
$g = [System.Drawing.Graphics]::FromImage($header)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
Draw-Gradient $g 150 57 $bgMid $bgDeep $false
Draw-SoftOrb $g 130 10 40 $accentSoft
$g.DrawImage($logo, 10, 10, 36, 36)
$fontH = New-Object System.Drawing.Font "Segoe UI Semibold", 9, ([System.Drawing.FontStyle]::Bold)
$fontS = New-Object System.Drawing.Font "Segoe UI", 7
$g.DrawString("Hormachuelos", $fontH, (New-Object System.Drawing.SolidBrush $textBright), 52, 12)
$g.DrawString("Installing your studio…", $fontS, (New-Object System.Drawing.SolidBrush $textMuted), 52, 30)
$g.Dispose()
Save-Bmp24 $header (Join-Path $outDir "nsis-header.bmp")
$header.Dispose()

# --- WiX banner: 493 × 58 ---
$banner = New-Object System.Drawing.Bitmap 493, 58
$g = [System.Drawing.Graphics]::FromImage($banner)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
Draw-Gradient $g 493 58 $bgDeep $bgMid $false
Draw-SoftOrb $g 420 0 70 $accentSoft
$g.DrawImage($logo, 16, 9, 40, 40)
$fontB = New-Object System.Drawing.Font "Segoe UI Semibold", 12, ([System.Drawing.FontStyle]::Bold)
$fontBs = New-Object System.Drawing.Font "Segoe UI", 8
$g.DrawString("Hormachuelos", $fontB, (New-Object System.Drawing.SolidBrush $textBright), 68, 10)
$g.DrawString("Desktop AI agent · Pay with GCash · Built for Filipino builders", $fontBs, (New-Object System.Drawing.SolidBrush $textMuted), 68, 32)
$g.Dispose()
Save-Bmp24 $banner (Join-Path $outDir "wix-banner.bmp")
$banner.Dispose()

# --- WiX dialog: 493 × 312 ---
$dialog = New-Object System.Drawing.Bitmap 493, 312
$g = [System.Drawing.Graphics]::FromImage($dialog)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
Draw-Gradient $g 493 312 $bgDeep ([System.Drawing.Color]::FromArgb(255, 22, 24, 30)) $true
Draw-SoftOrb $g 80 60 140 $accentSoft
Draw-SoftOrb $g 400 250 160 ([System.Drawing.Color]::FromArgb(35, 100, 180, 255))

$plate = 120
$dx = [int]((493 - $plate) / 2)
$dy = 70
$g.FillRectangle((New-SolidBrushColor 255 255 255), $dx, $dy, $plate, $plate)
$g.DrawImage($logo, $dx + 12, $dy + 12, $plate - 24, $plate - 24)

$fontD = New-Object System.Drawing.Font "Segoe UI Semibold", 18, ([System.Drawing.FontStyle]::Bold)
$fontDt = New-Object System.Drawing.Font "Segoe UI", 9.5
$g.DrawString("Welcome to Hormachuelos", $fontD, (New-Object System.Drawing.SolidBrush $textBright), (New-Object System.Drawing.RectangleF(24, 210, 445, 36)), $sf)
$g.DrawString("Pinoy-made AI for builders without bank accounts.`nLocal-first agent · GCash / Maya · PHP pricing", $fontDt, (New-Object System.Drawing.SolidBrush $textMuted), (New-Object System.Drawing.RectangleF(40, 248, 413, 48)), $sf)
$g.Dispose()
Save-Bmp24 $dialog (Join-Path $outDir "wix-dialog.bmp")
$dialog.Dispose()

$logo.Dispose()
$fontBrand.Dispose(); $fontTag.Dispose(); $fontH.Dispose(); $fontS.Dispose()
$fontB.Dispose(); $fontBs.Dispose(); $fontD.Dispose(); $fontDt.Dispose()
$sf.Dispose()

Write-Host "Installer art written to $outDir"
Get-ChildItem $outDir | Format-Table Name, Length

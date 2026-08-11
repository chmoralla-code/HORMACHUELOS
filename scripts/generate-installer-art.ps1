# Generates branded BMP / ICO assets for Hormachuelos NSIS + WiX installers.
# Run: powershell -ExecutionPolicy Bypass -File scripts/generate-installer-art.ps1

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root "src-tauri\installer"
$iconPath = Join-Path $root "src-tauri\icons\icon.png"
$visualPath = Join-Path $outDir "forge-ribbon-v2.png"
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

function Draw-Cover(
  [System.Drawing.Graphics]$g,
  [System.Drawing.Image]$source,
  [int]$x,
  [int]$y,
  [int]$width,
  [int]$height,
  [double]$focusX = 0.5,
  [double]$focusY = 0.5
) {
  # Scale first, then crop. This avoids stretching the generated visual into
  # the very different NSIS and WiX aspect ratios.
  $scale = [Math]::Max($width / [double]$source.Width, $height / [double]$source.Height)
  $cropWidth = [int][Math]::Min($source.Width, [Math]::Round($width / $scale))
  $cropHeight = [int][Math]::Min($source.Height, [Math]::Round($height / $scale))
  $sourceX = [int][Math]::Round(([Math]::Max(0, $source.Width - $cropWidth)) * $focusX)
  $sourceY = [int][Math]::Round(([Math]::Max(0, $source.Height - $cropHeight)) * $focusY)
  $destination = [System.Drawing.Rectangle]::new($x, $y, $width, $height)
  $g.DrawImage($source, $destination, $sourceX, $sourceY, $cropWidth, $cropHeight, [System.Drawing.GraphicsUnit]::Pixel)
}

function Save-Bmp24([System.Drawing.Bitmap]$bmp, [string]$path) {
  # NSIS/WiX prefer classic 24-bit BMP
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Bmp)
}

$logo = [System.Drawing.Image]::FromFile($iconPath)
$visual = [System.Drawing.Image]::FromFile($visualPath)
$bgDeep = [System.Drawing.Color]::FromArgb(255, 14, 14, 16)
$bgMid = [System.Drawing.Color]::FromArgb(255, 28, 30, 36)
$accent = [System.Drawing.Color]::FromArgb(255, 90, 160, 255)
$accentSoft = [System.Drawing.Color]::FromArgb(78, 90, 160, 255)
$textMuted = [System.Drawing.Color]::FromArgb(255, 180, 190, 210)
$textBright = [System.Drawing.Color]::FromArgb(255, 245, 246, 248)
$canvasLight = [System.Drawing.Color]::FromArgb(255, 248, 251, 255)
$canvasBlue = [System.Drawing.Color]::FromArgb(255, 222, 235, 255)

# --- NSIS sidebar (Welcome / Finish): 164 × 314 ---
$sidebar = New-Object System.Drawing.Bitmap 164, 314
$g = [System.Drawing.Graphics]::FromImage($sidebar)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
Draw-Cover $g $visual 0 0 164 314 0.72 0.44
$g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(142, 3, 8, 20))), 0, 0, 164, 314)
Draw-SoftOrb $g 136 92 92 $accentSoft
Draw-SoftOrb $g 28 260 86 ([System.Drawing.Color]::FromArgb(35, 82, 156, 255))

# Restrained content: unlike the header, this panel owns its typography.
$plate = 62
$px = [int]((164 - $plate) / 2)
$py = 42
$g.FillRectangle((New-SolidBrushColor 248 251 255), $px, $py, $plate, $plate)
$g.DrawImage($logo, $px + 7, $py + 7, $plate - 14, $plate - 14)

$fontBrand = New-Object System.Drawing.Font "Segoe UI Semibold", 10.2, ([System.Drawing.FontStyle]::Bold)
$fontTag = New-Object System.Drawing.Font "Segoe UI", 7.5
$fontEyebrow = New-Object System.Drawing.Font "Segoe UI Semibold", 6.2, ([System.Drawing.FontStyle]::Bold)
$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = [System.Drawing.StringAlignment]::Center
$g.DrawString("YOUR LOCAL AI STUDIO", $fontEyebrow, (New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 137, 192, 255))), (New-Object System.Drawing.RectangleF(8, 124, 148, 18)), $sf)
$g.DrawString("HORMACHUELOS", $fontBrand, (New-Object System.Drawing.SolidBrush $textBright), (New-Object System.Drawing.RectangleF(8, 144, 148, 28)), $sf)
$g.DrawString("Build with confidence.`nInspect, create, ship.", $fontTag, (New-Object System.Drawing.SolidBrush $textMuted), (New-Object System.Drawing.RectangleF(12, 180, 140, 48)), $sf)

$g.FillRectangle((New-Object System.Drawing.SolidBrush $accent), 52, 256, 60, 2)
$g.DrawString("LOCAL-FIRST · BUILT IN PH", $fontEyebrow, (New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 170, 200, 238))), (New-Object System.Drawing.RectangleF(8, 268, 148, 20)), $sf)
$g.Dispose()
Save-Bmp24 $sidebar (Join-Path $outDir "nsis-sidebar.bmp")
$sidebar.Dispose()

# --- NSIS header: 150 × 57 ---
# NSIS overlays page titles/subtitles onto this area. Leave it intentionally
# text-free and high-contrast so native copy always remains legible.
$header = New-Object System.Drawing.Bitmap 150, 57
$g = [System.Drawing.Graphics]::FromImage($header)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
Draw-Gradient $g 150 57 $canvasLight $canvasBlue $false
Draw-SoftOrb $g 148 3 48 ([System.Drawing.Color]::FromArgb(45, 63, 138, 255))
$g.FillRectangle((New-Object System.Drawing.SolidBrush $accent), 0, 55, 150, 2)
$g.Dispose()
Save-Bmp24 $header (Join-Path $outDir "nsis-header.bmp")
$header.Dispose()

# --- WiX banner: 493 × 58 ---
$banner = New-Object System.Drawing.Bitmap 493, 58
$g = [System.Drawing.Graphics]::FromImage($banner)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
Draw-Gradient $g 493 58 $canvasLight $canvasBlue $false
Draw-Cover $g $visual 332 0 161 58 0.76 0.44
$g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(105, 241, 247, 255))), 332, 0, 161, 58)
$g.FillRectangle((New-Object System.Drawing.SolidBrush $accent), 0, 56, 493, 2)
$g.Dispose()
Save-Bmp24 $banner (Join-Path $outDir "wix-banner.bmp")
$banner.Dispose()

# --- WiX dialog: 493 × 312 ---
$dialog = New-Object System.Drawing.Bitmap 493, 312
$g = [System.Drawing.Graphics]::FromImage($dialog)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
Draw-Cover $g $visual 0 0 493 312 0.70 0.46
$g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(75, 3, 8, 18))), 0, 0, 493, 312)
$g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(150, 7, 12, 25))), 0, 0, 220, 312)
$g.FillRectangle((New-Object System.Drawing.SolidBrush $accent), 0, 0, 4, 312)
$g.Dispose()
Save-Bmp24 $dialog (Join-Path $outDir "wix-dialog.bmp")
$dialog.Dispose()

$logo.Dispose()
$visual.Dispose()
$fontBrand.Dispose(); $fontTag.Dispose(); $fontEyebrow.Dispose()
$sf.Dispose()

Write-Host "Installer art written to $outDir"
Get-ChildItem $outDir | Format-Table Name, Length

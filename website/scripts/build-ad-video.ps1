# Builds Hormachuelos demo ad: intro + branded demo + outro CTA
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$videos = Join-Path $root "website\videos"
$tmp = Join-Path $videos "tmp-ad"
$src = Join-Path $videos "hormachuelos-demo.mp4"
$out = Join-Path $videos "hormachuelos-demo-ad.mp4"
$scripts = $PSScriptRoot

New-Item -ItemType Directory -Force -Path $tmp | Out-Null
Copy-Item "C:\Windows\Fonts\segoeuib.ttf" (Join-Path $tmp "font-bold.ttf") -Force
Copy-Item "C:\Windows\Fonts\segoeui.ttf" (Join-Path $tmp "font-reg.ttf") -Force
if (-not (Test-Path $src)) { throw "Missing source demo: $src" }

$intro = Join-Path $tmp "01-intro.mp4"
$main = Join-Path $tmp "02-main.mp4"
$outro = Join-Path $tmp "03-outro.mp4"
$list = Join-Path $tmp "concat.txt"

$introVf = (Get-Content (Join-Path $scripts "filters-intro.txt") -Raw).Trim()
$mainVf = (Get-Content (Join-Path $scripts "filters-main.txt") -Raw).Trim()
$outroVf = (Get-Content (Join-Path $scripts "filters-outro.txt") -Raw).Trim()

Write-Host ">> Intro (4.5s)..."
Push-Location $tmp
try {
& ffmpeg -y -hide_banner -loglevel error `
  -f lavfi -i "color=c=0x0a0a0a:s=1920x1080:r=30:d=4.5" `
  -f lavfi -i "anullsrc=channel_layout=stereo:sample_rate=48000" `
  -t 4.5 `
  -vf $introVf `
  -c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p `
  -c:a aac -b:a 128k -shortest $intro
if ($LASTEXITCODE -ne 0) { throw "Intro encode failed" }

Write-Host ">> Main demo + ad overlay (may take a few minutes)..."
& ffmpeg -y -hide_banner -loglevel error `
  -i $src `
  -vf $mainVf `
  -c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p `
  -c:a aac -b:a 192k $main
if ($LASTEXITCODE -ne 0) { throw "Main encode failed" }

Write-Host ">> Outro (5s)..."
& ffmpeg -y -hide_banner -loglevel error `
  -f lavfi -i "color=c=0x0a0a0a:s=1920x1080:r=30:d=5" `
  -f lavfi -i "anullsrc=channel_layout=stereo:sample_rate=48000" `
  -t 5 `
  -vf $outroVf `
  -c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p `
  -c:a aac -b:a 128k -shortest $outro
if ($LASTEXITCODE -ne 0) { throw "Outro encode failed" }
} finally { Pop-Location }

$introPath = ($intro -replace '\\', '/')
$mainPath = ($main -replace '\\', '/')
$outroPath = ($outro -replace '\\', '/')
"file '$introPath'`nfile '$mainPath'`nfile '$outroPath'" | Set-Content -Path $list -Encoding ASCII

Write-Host ">> Concat..."
& ffmpeg -y -hide_banner -loglevel error -f concat -safe 0 -i $list -c copy $out
if ($LASTEXITCODE -ne 0) { throw "Concat failed" }

Write-Host "Done: $out"
Get-Item $out | Format-List FullName, @{N='MB';E={[math]::Round($_.Length/1MB,1)}}

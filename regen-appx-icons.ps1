# Regenerates every PNG in build\appx\ from build\icon.png.
# Square targets get a direct resize. Rectangular targets center the icon
# (scaled to the shorter dimension) on a transparent canvas - the manifest
# BackgroundColor (#0a0a0c) shows through behind the splash and tiles.
#
# Run from the repo root:  powershell -ExecutionPolicy Bypass -File .\regen-appx-icons.ps1

Add-Type -AssemblyName System.Drawing

$root   = Split-Path -Parent $MyInvocation.MyCommand.Path
$source = Join-Path $root 'build\icon.png'
$outDir = Join-Path $root 'build\appx'

if (-not (Test-Path $source)) { throw "Source icon not found: $source" }
if (-not (Test-Path $outDir)) { throw "Output dir not found: $outDir" }

# filename -> [width, height]
$targets = @{
  'BadgeLogo.png'                                         = @(24, 24)
  'BadgeLogo.scale-200.png'                               = @(48, 48)
  'BadgeLogo.scale-400.png'                               = @(96, 96)
  'LargeTile.png'                                         = @(310, 310)
  'LargeTile.scale-200.png'                               = @(620, 620)
  'LargeTile.scale-400.png'                               = @(1240, 1240)
  'SmallTile.png'                                         = @(71, 71)
  'SmallTile.scale-200.png'                               = @(142, 142)
  'SmallTile.scale-400.png'                               = @(284, 284)
  'SplashScreen.png'                                      = @(620, 300)
  'SplashScreen.scale-200.png'                            = @(1240, 600)
  'SplashScreen.scale-400.png'                            = @(2480, 1200)
  'Square150x150Logo.png'                                 = @(150, 150)
  'Square150x150Logo.scale-200.png'                       = @(300, 300)
  'Square150x150Logo.scale-400.png'                       = @(600, 600)
  'Square44x44Logo.png'                                   = @(44, 44)
  'Square44x44Logo.scale-200.png'                         = @(88, 88)
  'Square44x44Logo.scale-400.png'                         = @(176, 176)
  'Square44x44Logo.targetsize-16.png'                     = @(16, 16)
  'Square44x44Logo.targetsize-48.png'                     = @(48, 48)
  'Square44x44Logo.targetsize-256.png'                    = @(256, 256)
  'Square44x44Logo.altform-unplated_targetsize-16.png'    = @(16, 16)
  'Square44x44Logo.altform-unplated_targetsize-48.png'    = @(48, 48)
  'Square44x44Logo.altform-unplated_targetsize-256.png'   = @(256, 256)
  'Square44x44Logo.altform-lightunplated_targetsize-16.png'  = @(16, 16)
  'Square44x44Logo.altform-lightunplated_targetsize-48.png'  = @(48, 48)
  'Square44x44Logo.altform-lightunplated_targetsize-256.png' = @(256, 256)
  'StoreLogo.png'                                         = @(50, 50)
  'StoreLogo.scale-200.png'                               = @(100, 100)
  'StoreLogo.scale-400.png'                               = @(200, 200)
  'Wide310x150Logo.png'                                   = @(310, 150)
  'Wide310x150Logo.scale-200.png'                         = @(620, 300)
  'Wide310x150Logo.scale-400.png'                         = @(1240, 600)
}

$src = [System.Drawing.Image]::FromFile($source)
try {
  foreach ($name in $targets.Keys) {
    $w   = $targets[$name][0]
    $h   = $targets[$name][1]
    $out = Join-Path $outDir $name

    $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality

    if ($w -eq $h) {
      $g.DrawImage($src, 0, 0, $w, $h)
    } else {
      $iconSize = [Math]::Min($w, $h)
      $x = [int](($w - $iconSize) / 2)
      $y = [int](($h - $iconSize) / 2)
      $g.DrawImage($src, $x, $y, $iconSize, $iconSize)
    }

    $g.Dispose()
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host ("  {0,5}x{1,-5}  {2}" -f $w, $h, $name)
  }
} finally {
  $src.Dispose()
}

Write-Host ""
Write-Host "Done. Regenerated $($targets.Count) files in $outDir"

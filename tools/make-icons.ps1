# Genera le icone PNG dell'estensione (fumetto + forma d'onda).
# Uso: powershell -ExecutionPolicy Bypass -File tools/make-icons.ps1
Add-Type -AssemblyName System.Drawing

function New-RoundedPath {
  param([float]$x, [float]$y, [float]$w, [float]$h, [float]$r)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $path.AddArc($x, $y, $d, $d, 180, 90)
  $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

$outDir = Join-Path $PSScriptRoot '..\icons'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$greenTop = [System.Drawing.Color]::FromArgb(255, 37, 211, 102)
$greenBottom = [System.Drawing.Color]::FromArgb(255, 0, 128, 105)
$white = [System.Drawing.Color]::White
$barGreen = [System.Drawing.Color]::FromArgb(255, 0, 116, 94)

foreach ($size in @(16, 32, 48, 96, 128)) {
  $scale = 8
  $w = $size * $scale
  $big = New-Object System.Drawing.Bitmap($w, $w)
  $g = [System.Drawing.Graphics]::FromImage($big)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)

  # Sfondo: quadrato arrotondato con gradiente verde.
  $bgPath = New-RoundedPath 0 0 $w $w ($w * 0.24)
  $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $w)
  $bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $greenTop, $greenBottom, 90)
  $g.FillPath($bgBrush, $bgPath)

  # Fumetto bianco.
  $bubbleX = $w * 0.15
  $bubbleY = $w * 0.17
  $bubbleW = $w * 0.70
  $bubbleH = $w * 0.51
  $bubble = New-RoundedPath $bubbleX $bubbleY $bubbleW $bubbleH ($w * 0.14)
  $g.FillPath([System.Drawing.Brushes]::White, $bubble)

  # Codina del fumetto.
  $tail = New-Object System.Drawing.Drawing2D.GraphicsPath
  $tail.AddPolygon(@(
    (New-Object System.Drawing.PointF(($w * 0.29), ($w * 0.665))),
    (New-Object System.Drawing.PointF(($w * 0.26), ($w * 0.83))),
    (New-Object System.Drawing.PointF(($w * 0.44), ($w * 0.665)))
  ))
  $g.FillPath([System.Drawing.Brushes]::White, $tail)

  # Forma d'onda dentro il fumetto.
  $barW = $w * 0.075
  $barGap = $w * 0.045
  $totalW = 4 * $barW + 3 * $barGap
  $startX = ($w - $totalW) / 2
  $midY = $bubbleY + $bubbleH / 2
  $heights = @(0.10, 0.19, 0.25, 0.15)
  $barBrush = New-Object System.Drawing.SolidBrush($barGreen)
  for ($i = 0; $i -lt 4; $i++) {
    $h = $w * $heights[$i]
    $x = $startX + $i * ($barW + $barGap)
    $y = $midY - $h / 2
    $bar = New-RoundedPath $x $y $barW $h ($barW / 2)
    $g.FillPath($barBrush, $bar)
    $bar.Dispose()
  }

  $g.Dispose()

  # Ridimensionamento con antialiasing.
  $small = New-Object System.Drawing.Bitmap($size, $size)
  $sg = [System.Drawing.Graphics]::FromImage($small)
  $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $sg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $sg.DrawImage($big, (New-Object System.Drawing.Rectangle(0, 0, $size, $size)))
  $sg.Dispose()

  $file = Join-Path $outDir ("icon-" + $size + ".png")
  $small.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  $small.Dispose()
  $big.Dispose()
  Write-Host ("creata " + $file)
}

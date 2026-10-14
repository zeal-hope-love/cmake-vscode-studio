# 检查 release/ 下每个 exe 的签名状态与时间戳
#
#   npm run verify:signature
#
# 关心的三件事：
#   Status                —— Valid 才算签成功
#   Signer                —— 签名者是不是你
#   Timestamped           —— 有没有打时间戳（不打的话证书过期后已发出去的 exe 签名会失效）

$releaseDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'release'

if (-not (Test-Path $releaseDir)) {
  Write-Host "找不到 release 目录，先跑一次打包：npm run dist:installer" -ForegroundColor Yellow
  exit 1
}

$files = Get-ChildItem $releaseDir -Filter *.exe -File -ErrorAction SilentlyContinue
if (-not $files) {
  Write-Host "release 目录里没有 exe" -ForegroundColor Yellow
  exit 1
}

$rows = foreach ($file in $files) {
  $sig = Get-AuthenticodeSignature -LiteralPath $file.FullName
  [pscustomobject]@{
    文件     = $file.Name
    大小MB   = [math]::Round($file.Length / 1MB, 1)
    签名状态 = $sig.Status
    签名者   = if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { '（未签名）' }
    已打时间戳 = [bool]$sig.TimeStamperCertificate
  }
}

$rows | Format-List

Write-Host ''
if ($rows.签名状态 -contains 'Valid') {
  Write-Host '✓ 有 exe 已正确签名' -ForegroundColor Green
} else {
  Write-Host '未检测到有效签名 —— 现在打包出来的 exe 会触发 SmartScreen 警告。' -ForegroundColor Yellow
  Write-Host '配置签名的方法见 docs/DEVELOPMENT.md 第三节：' -ForegroundColor Yellow
  Write-Host '  · 推荐 Azure Trusted Signing（约 $10/月，无需硬件令牌）' -ForegroundColor Yellow
  Write-Host '  · 配置在 electron-builder.yml 的 win.azureSignOptions' -ForegroundColor Yellow
}

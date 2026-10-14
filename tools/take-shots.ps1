# 开发期截图脚本：对每个页面各截一张，用于人工核对界面。
# 用法： pwsh -File tools/take-shots.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$shotDir = Join-Path $root '.dsh_shots'
New-Item -ItemType Directory -Force -Path $shotDir | Out-Null

# 截图前把主题重置为深色，保证每次跑出来的基准一致
$settingsFile = Join-Path $env:APPDATA 'cmake-vscode-studio\settings.json'
if (Test-Path $settingsFile) {
  $cfg = Get-Content $settingsFile -Raw | ConvertFrom-Json
  $cfg.theme = 'dark'
  $cfg | ConvertTo-Json -Depth 10 | Set-Content -Path $settingsFile -Encoding UTF8
}

$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) { throw "找不到 electron.exe: $electron" }

function Click-Nav([string]$label) {
  return "[...document.querySelectorAll('.navitem')].find(b=>b.textContent.includes('$label'))?.click()"
}

$shots = @(
  @{ name = '01-project';   js = $null },
  @{ name = '02-launch';    js = (Click-Nav 'launch') },
  @{ name = '03-tasks';     js = (Click-Nav 'tasks') },
  @{ name = '04-settings';  js = (Click-Nav 'settings') },
  @{ name = '05-cpp';       js = (Click-Nav 'IntelliSense') },
  @{ name = '06-tools';     js = (Click-Nav '工具与路径') },
  @{ name = '07-templates'; js = (Click-Nav '模板与批量') },
  @{ name = '08-build';     js = (Click-Nav '构建与烧录') },
  @{ name = '09-preview';   js = "[...document.querySelectorAll('.btn')].find(b=>b.textContent.trim()==='预览')?.click()" },
  @{ name = '10-light';     js = "[...document.querySelectorAll('.navitem')].find(b=>b.textContent.includes('launch'))?.click(); [...document.querySelectorAll('.btn')].find(b=>b.title && b.title.includes('主题'))?.click()" }
)

foreach ($shot in $shots) {
  $out = Join-Path $shotDir "$($shot.name).png"
  if (Test-Path $out) { Remove-Item $out -Force }

  $env:CFGSTUDIO_SHOT = $out
  $env:CFGSTUDIO_SHOT_DELAY = '6500'
  if ($shot.js) { $env:CFGSTUDIO_SHOT_JS = $shot.js } else { Remove-Item Env:CFGSTUDIO_SHOT_JS -ErrorAction SilentlyContinue }

  Write-Host "--- 截图: $($shot.name) ---"
  # 注意：不能写成 `*> $null` 或 `> $null` —— 那样 Electron 会静默起不来
  # （$LASTEXITCODE 为空、什么都不发生）。管道到 Set-Content 是可行的。
  & $electron . 2>&1 | Set-Content -Path (Join-Path $shotDir 'run.log') -Encoding UTF8

  if (Test-Path $out) {
    Write-Host ("    OK  {0:N0} KB" -f ((Get-Item $out).Length / 1KB))
  } else {
    Write-Host "    失败：没有生成文件"
    Get-Content (Join-Path $shotDir 'run.log') -ErrorAction SilentlyContinue |
      Select-Object -Last 12 | ForEach-Object { "      | $_" }
  }

  # 给 Chromium 一点时间释放 GPU 缓存文件锁，否则下一轮会报 cache 错误
  Start-Sleep -Milliseconds 900
}

Remove-Item Env:CFGSTUDIO_SHOT, Env:CFGSTUDIO_SHOT_JS, Env:CFGSTUDIO_SHOT_DELAY -ErrorAction SilentlyContinue
Write-Host "`n全部完成，输出目录: $shotDir"
Get-ChildItem $shotDir -Filter *.png | ForEach-Object { "  {0,-16} {1,8:N0} KB" -f $_.Name, ($_.Length / 1KB) }

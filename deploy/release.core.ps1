#requires -Version 7
# Aural interview system production release core script. PowerShell 7 only.
# The ASCII launcher deploy/release.ps1 forwards here from PowerShell 5.1.
# Target: the dedicated interview tool machine behind the legacy jump host.
# The legacy /root/aural-oss tree is never modified and remains the final
# rollback target; releases land in /root/aural/releases with atomic switch.
param(
  [string]$Revision = "HEAD",
  [string]$WslDistribution = "Ubuntu",
  [string]$IdentityFile = "",
  [string]$JumpHost = "root@123.57.152.131",
  [string]$TargetHost = "root@172.28.145.158",
  [string]$PublicBaseUrl = "https://agitest.yifx.vip",
  [switch]$Apply,
  [switch]$ForceRebuild,
  [switch]$PreflightOnly
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Convert-ToBashLiteral([string]$Value) {
  if ($Value.Contains("'")) { throw "Bash 参数不得包含单引号" }
  return "'$Value'"
}

function Convert-ToWslPath([string]$Path) {
  $fullPath = [System.IO.Path]::GetFullPath($Path)
  if ($fullPath -notmatch '^([A-Za-z]):\\(.*)$') { throw "仅支持 Windows 绝对路径：$fullPath" }
  return "/mnt/$($Matches[1].ToLowerInvariant())/$($Matches[2].Replace('\', '/'))"
}

# ---- 0. 仓库与规范 --------------------------------------------------------
$repoRoot = (git rev-parse --show-toplevel).Trim()
Set-Location $repoRoot
Get-Content (Join-Path $repoRoot "DEPLOYMENT_POLICY.md") | Out-Null
Get-Content (Join-Path $repoRoot "AGENTS.md") | Out-Null

# ---- 1. 固定 SSH 客户端与专用密钥（经跳板）--------------------------------
$sshExe = Join-Path $env:SystemRoot "System32\OpenSSH\ssh.exe"
if (-not (Test-Path $sshExe)) { $sshExe = (Get-Command ssh -ErrorAction Stop).Source }
$scpExe = Join-Path $env:SystemRoot "System32\OpenSSH\scp.exe"
if (-not (Test-Path $scpExe)) { $scpExe = (Get-Command scp -ErrorAction Stop).Source }

if (-not $IdentityFile) { $IdentityFile = Join-Path $env:USERPROFILE ".ssh\aural-tool.pem" }
$resolvedIdentity = (Resolve-Path -LiteralPath $IdentityFile -ErrorAction Stop).Path
$sshCommonArgs = @(
  "-o", "BatchMode=yes",
  "-o", "IdentitiesOnly=yes",
  "-o", "ConnectTimeout=20",
  "-o", "ServerAliveInterval=30",
  "-o", "ProxyJump=$JumpHost",
  "-i", $resolvedIdentity
)

# ---- 2. Git 门禁 + 仓库自有 pre-deploy 钩子 -------------------------------
$sha = (git rev-parse "$Revision^{commit}").Trim()
if ($sha -notmatch '^[0-9a-f]{40}$') { throw "无法解析完整提交 SHA" }
if ((git branch --show-current).Trim() -ne "main") { throw "正式发布只能从本地 main 分支执行" }
$treeDirty = [bool](git status --porcelain --untracked-files=no)
if ($treeDirty -and -not $PreflightOnly) { throw "发布前已跟踪文件必须干净" }
$fetchOk = $false
for ($attempt = 1; $attempt -le 3 -and -not $fetchOk; $attempt++) {
  git fetch origin main 2>$null
  if ($LASTEXITCODE -eq 0) { $fetchOk = $true } else { Start-Sleep -Seconds 5 }
}
if (-not $fetchOk) { throw "无法获取 origin/main（GitHub 不可达或凭据失效，已重试 3 次）" }
$originMain = (git rev-parse origin/main).Trim()
if ($sha -ne $originMain) { throw "待发布提交必须等于 origin/main：$originMain" }

if (-not $PreflightOnly) {
  if ($env:OPRUN_AURAL_RELEASE_APPROVED_SHA -ne $sha) {
    throw "OPRUN_AURAL_RELEASE_APPROVED_SHA 必须等于 $sha"
  }
  $hook = Join-Path $repoRoot ".githooks\pre-deploy"
  if (Test-Path $hook) {
    $env:OPRUN_USER_APPROVED = "YES"
    $env:OPRUN_APPROVED_ACTION = "deploy"
    $env:OPRUN_APPROVED_SHA = $sha
    & wsl.exe -d $WslDistribution -- bash -lc "cd $(Convert-ToBashLiteral (Convert-ToWslPath $repoRoot)) && OPRUN_USER_APPROVED=YES OPRUN_APPROVED_ACTION=deploy OPRUN_APPROVED_SHA=$sha bash .githooks/pre-deploy"
    if ($LASTEXITCODE -ne 0) { throw "仓库 pre-deploy 钩子未通过" }
    Write-Host "门禁=仓库 pre-deploy 钩子 PASS"
  }
}

Write-Host "系统=aural-interview-production"
Write-Host "SHA=$sha"
Write-Host "目标=$TargetHost（经跳板 $JumpHost）"
Write-Host "公网=$PublicBaseUrl"

# ---- 3. 快速预检（只读探测，秒级失败）-------------------------------------
& wsl.exe -d $WslDistribution -- true
if ($LASTEXITCODE -ne 0) { throw "WSL 预检失败：发行版 $WslDistribution 不可用" }
$nodeVersion = (& wsl.exe -d $WslDistribution -- bash -lc @'
source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
nvm use 20.20.2 >/dev/null 2>&1 || true
node --version 2>/dev/null || echo node-missing
'@) -join ""
if ($nodeVersion -notmatch '^v(20|24)\.') { throw "WSL Node 预检失败（当前 $nodeVersion）" }
Write-Host "预检=本地工具链 PASS（$nodeVersion / WSL $WslDistribution）"

$remoteProbe = @'
echo "conn=ok"
df -P /root | awk 'NR==2{print "disk_avail_kb=" $4}'
free -m | awk 'NR==2{print "mem_avail_mb=" $7}'
systemctl is-active --quiet aural.service aural-voice.service && echo "services=ok" || echo "services=down"
systemctl is-active --quiet aural-openai-voice.service && echo "fallback_service=ok" || echo "fallback_service=missing_or_down"
systemctl is-active --quiet docker && echo "docker=ok" || echo "docker=down"
if [ -f /root/aural/current/REVISION ]; then echo "revision=$(cat /root/aural/current/REVISION)"; elif [ -f /root/aural-oss/REVISION ]; then echo "revision=$(cat /root/aural-oss/REVISION)"; else echo "revision=unknown"; fi
A=$(docker exec supabase_db_aural psql -U postgres -d postgres -t -A -c "select count(*) from sessions where status='IN_PROGRESS' AND \"lastActivityAt\" > now() - interval '5 minutes'" 2>/dev/null | tr -d '[:space:]')
echo "active_sessions=${A:-0}"
'@
$probeOutput = (& $sshExe @sshCommonArgs $TargetHost $remoteProbe) -join "`n"
if ($LASTEXITCODE -ne 0 -or $probeOutput -notmatch 'conn=ok') {
  throw "SSH 预检失败：无法经跳板连接 $TargetHost（未进入测试和构建）"
}
$diskAvailKb = 0
if ($probeOutput -match 'disk_avail_kb=(\d+)') { $diskAvailKb = [long]$Matches[1] }
$diskAvailGb = [math]::Round($diskAvailKb / 1MB, 1)
if ($diskAvailGb -lt 5) { throw "磁盘预检失败：/root 仅剩 ${diskAvailGb}GB（发布需约 3GB）" }
if ($probeOutput -notmatch 'services=ok') { throw "SSH 预检失败：aural 双服务当前未运行（先恢复再发布）" }
$onlineRevision = "unknown"
if ($probeOutput -match 'revision=([0-9a-f]{40}|unknown)') { $onlineRevision = $Matches[1] }
if ($probeOutput -match 'docker=down') { Write-Host "警告=docker 未运行（Supabase 依赖需人工确认）" }
Write-Host "预检=SSH PASS（磁盘剩余 ${diskAvailGb}GB、线上版本=$($onlineRevision.Substring(0, [Math]::Min(7, $onlineRevision.Length)))）"
if ($onlineRevision -eq $sha) {
  Write-Host "结论=该 SHA 已在线上运行，无需发布"
  exit 0
}
if ($PreflightOnly) {
  Write-Host "PreflightOnly=诊断结束，未执行构建与任何生产变更"
  exit 0
}
if (-not $Apply) { Write-Host "DRY-RUN：添加 -Apply 后才会构建和发布"; exit 0 }

# 活跃面试排空（2026-08-20）：5 分钟内有活动的会话存在时等待其结束再切换，
# 避免发布重启打断真人面试（当晚已误伤两次）。
if ($probeOutput -match 'active_sessions=(\d+)') {
  $activeSessions = [int]$Matches[1]
  if ($activeSessions -gt 0) {
    Write-Host "排空=${activeSessions} 场面试进行中，等待结束（最多 20 分钟）…"
    for ($waitRound = 1; $waitRound -le 20; $waitRound++) {
      Start-Sleep -Seconds 60
      $reProbe = (& $sshExe @sshCommonArgs $TargetHost $remoteProbe) -join "`n"
      if ($reProbe -match 'active_sessions=(\d+)') { $activeSessions = [int]$Matches[1] }
      Write-Host "排空=第 ${waitRound} 分钟，剩余 ${activeSessions} 场"
      if ($activeSessions -eq 0) { break }
    }
    if ($activeSessions -gt 0) { throw "仍有 ${activeSessions} 场活跃面试，为避免打断已中止发布（稍后重试）" }
  }
}

# ---- 4. 构建或复用制品 -----------------------------------------------------
$artifactDir = Join-Path $repoRoot ".artifacts\production"
$tempDir = Join-Path $repoRoot ".tmp"
New-Item -ItemType Directory -Force $artifactDir, $tempDir | Out-Null
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$artifact = Join-Path $artifactDir "aural-$sha.tar.gz"
$checksumFile = "$artifact.sha256"
$buildInfoFile = Join-Path $artifactDir "aural-$sha.buildinfo.json"

$artifactValid = $false
if ((Test-Path $artifact) -and (Test-Path $checksumFile)) {
  $recordedDigest = (Get-Content $checksumFile -Raw).Trim().Split(" ")[0]
  $actualDigest = ((Get-FileHash -Algorithm SHA256 $artifact).Hash).ToLowerInvariant()
  $artifactValid = ($recordedDigest -eq $actualDigest)
}
$reuse = $artifactValid -and -not $ForceRebuild

if ($reuse) {
  $checksum = (Get-Content $checksumFile -Raw).Trim().Split(" ")[0]
  Write-Host "制品=复用（同 SHA、摘要一致；-ForceRebuild 可强制重建）"
} else {
  $buildEnvFile = Join-Path $tempDir "aural-build-$sha.env"
  $envContent = (& $sshExe @sshCommonArgs $TargetHost "grep -E '^[A-Za-z_][A-Za-z0-9_]*=' /root/aural/env/.env.local 2>/dev/null || grep -E '^[A-Za-z_][A-Za-z0-9_]*=' /root/aural-oss/.env.local") -join "`n"
  if (-not $envContent) { throw "未能取得构建期环境变量" }
  try {
    [System.IO.File]::WriteAllText($buildEnvFile, $envContent + "`n", $utf8NoBom)
    $sourceTar = Join-Path $tempDir "aural-source-$sha.tar"
    git archive --format=tar --output=$sourceTar $sha
    if ($LASTEXITCODE -ne 0) { throw "生成已提交源码归档失败" }
    $builderSource = Join-Path $repoRoot "deploy\build-release-wsl.sh"
    $builderTemp = Join-Path $tempDir "build-release-$sha.lf.sh"
    $builderContent = [System.IO.File]::ReadAllText($builderSource).Replace("`r`n", "`n")
    [System.IO.File]::WriteAllText($builderTemp, $builderContent, $utf8NoBom)
    $builderCommand = "exec bash $(Convert-ToBashLiteral (Convert-ToWslPath $builderTemp)) " +
      "$(Convert-ToBashLiteral (Convert-ToWslPath $sourceTar)) $(Convert-ToBashLiteral (Convert-ToWslPath $artifactDir)) " +
      "$(Convert-ToBashLiteral $sha) $(Convert-ToBashLiteral (Convert-ToWslPath $buildEnvFile))"
    Write-Host "构建=开始（测试+构建约 5-10 分钟）"
    & wsl.exe -d $WslDistribution -- bash -lc $builderCommand
    if ($LASTEXITCODE -ne 0) { throw "WSL 制品构建失败" }
  }
  finally {
    if (Test-Path -LiteralPath $buildEnvFile) {
      Remove-Item -LiteralPath $buildEnvFile -Force
    }
  }
  if (-not (Test-Path $artifact)) { throw "构建完成但未找到制品：$artifact" }
  $checksum = ((Get-FileHash -Algorithm SHA256 $artifact).Hash).ToLowerInvariant()

  $buildInfo = [ordered]@{
    schema = "aural-buildinfo.v1"
    sha = $sha
    node_version = "20.20.2"
    wsl_distribution = $WslDistribution
    built_at = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
    checks = "test:web,test:functional,next-build"
  }
  [System.IO.File]::WriteAllText($buildInfoFile, ($buildInfo | ConvertTo-Json -Compress), $utf8NoBom)
  Write-Host "构建=PASS（制品 sha256=$($checksum.Substring(0,16))…）"
}

# ---- 5. 上传与服务器端应用 -------------------------------------------------
$remoteBootstrap = "/tmp/aural-bootstrap-$sha"
$applyScript = Join-Path $repoRoot "deploy\production\apply-release.sh"
$applyTemp = Join-Path $tempDir "apply-release-$sha.lf.sh"
$applyContent = [System.IO.File]::ReadAllText($applyScript).Replace("`r`n", "`n")
[System.IO.File]::WriteAllText($applyTemp, $applyContent, $utf8NoBom)

& $sshExe @sshCommonArgs $TargetHost "mkdir -p -m 700 $remoteBootstrap"
if ($LASTEXITCODE -ne 0) { throw "无法创建临时上传目录" }
$artifactSizeMb = [math]::Round((Get-Item $artifact).Length / 1MB, 0)
Write-Host "上传=${artifactSizeMb}MB 制品，经跳板传输约 2-10 分钟，请耐心等待"
$uploadFiles = @($artifact, $applyTemp)
$sweeperFiles = @(
  (Join-Path $repoRoot "deploy\production\install-stale-session-sweeper.sh"),
  (Join-Path $repoRoot "deploy\production\stale-session-sweeper.sh")
)
foreach ($sf in $sweeperFiles) {
  $sfTemp = Join-Path $tempDir (Split-Path $sf -Leaf)
  [System.IO.File]::WriteAllText($sfTemp, [System.IO.File]::ReadAllText($sf).Replace("`r`n", "`n"), $utf8NoBom)
  $uploadFiles += $sfTemp
}
& $scpExe @sshCommonArgs @uploadFiles "${TargetHost}:$remoteBootstrap/"
if ($LASTEXITCODE -ne 0) { throw "上传制品失败" }
& $sshExe @sshCommonArgs $TargetHost "OPRUN_AURAL_RELEASE_APPROVED_SHA=$sha bash $remoteBootstrap/$(Split-Path $applyTemp -Leaf) $remoteBootstrap/aural-$sha.tar.gz $checksum $sha"
if ($LASTEXITCODE -ne 0) { throw "正式制品应用失败" }
& $sshExe @sshCommonArgs $TargetHost "rm -rf -- $remoteBootstrap"
if ($LASTEXITCODE -ne 0) { Write-Warning "发布成功，但临时目录清理失败" }

# ---- 6. 公网、版本、健康与语音线路验收 -------------------------------------
$publicRoot = $PublicBaseUrl.TrimEnd('/')
$finalStatus = (& curl.exe -fsSL --max-redirs 5 --max-time 20 -o NUL -w "%{http_code}" "$publicRoot/") -join ""
if ($LASTEXITCODE -ne 0 -or $finalStatus.Trim() -ne "200") {
  throw "公网验收失败：重定向后状态=$finalStatus"
}
$versionPayload = ((& curl.exe -fsSL --max-redirs 5 --max-time 20 "$publicRoot/api/version") -join "") | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $versionPayload.revision -ne $sha) {
  throw "公网版本验收失败：revision=$($versionPayload.revision)"
}
& curl.exe -fsSL --max-redirs 5 --max-time 20 -o NUL "$publicRoot/api/health"
if ($LASTEXITCODE -ne 0) { throw "公网健康检查失败" }
& curl.exe -fsSL --max-redirs 5 --max-time 20 -o NUL "$publicRoot/api/ready"
if ($LASTEXITCODE -ne 0) { throw "公网就绪检查失败" }
$wsProbe = 'const {WebSocket}=require("ws");const ports=[8766,8767];Promise.all(ports.map(p=>new Promise((ok,fail)=>{const w=new WebSocket(`ws://127.0.0.1:${p}`);const t=setTimeout(()=>fail(new Error(`timeout:${p}`)),5000);w.once("open",()=>{clearTimeout(t);w.close();ok(p)});w.once("error",fail)}))).then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)})'
& $sshExe @sshCommonArgs $TargetHost "cd /root/aural/current && node -e '$wsProbe'"
if ($LASTEXITCODE -ne 0) { throw "主/备用语音 WebSocket 握手失败" }
$deployedRevision = (& $sshExe @sshCommonArgs $TargetHost "cat /root/aural/current/REVISION") -join ""
if ($deployedRevision.Trim() -ne $sha) { throw "版本验收失败：current/REVISION=$deployedRevision" }

# ---- 7. 结构化摘要与发布记录 -----------------------------------------------
$summary = [ordered]@{
  ts = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
  system = "aural-interview-production"
  sha = $sha
  mode = if ($reuse) { "artifact-reuse" } else { "full-build" }
  tests = if ($reuse) { "reused" } else { "PASS(test:web,test:functional)" }
  artifact_sha256 = $checksum
  upload = "PASS"
  switch = "PASS"
  public_site = "PASS"
  health_ready = "PASS"
  voice_websocket_handshake = "PASS(primary,fallback)"
  revision_marker = "PASS"
  rollback = "previous 链接与 /root/aural-oss 原目录均已保留"
}
$summary | ConvertTo-Json -Compress | Write-Host
$releaseLog = Join-Path $artifactDir "release-log.jsonl"
Add-Content -LiteralPath $releaseLog -Value ($summary | ConvertTo-Json -Compress) -Encoding utf8NoBOM

Write-Host "Aural production deployment complete: $sha"
exit 0

# =============================================================================
# Guattari 名词索引 - 一键流水线
#
# 流程：
#   1) 准备 .env（如果没有则从 .env.example 复制）
#   2) 准备 Python venv + spaCy + fr_core_news_sm 模型
#   3) 启动 spaCy sidecar（新窗口，阻塞）
#   4) 等 sidecar 健康检查通过
#   5) 跑 validate-s0-quality.js（生成 s0-hits.json + s0-quality-report.json）
#   6) 跑 s1-llm-fill.js（生成 s1-nouns-with-offsets.json）
#   7) 跑 merge-s0-s1.js（生成 final-noun-index.json.new）
#   8) 关掉 sidecar
#
# 用法（在你本机 PowerShell 里）：
#   cd C:\Users\Administrator\Desktop\ni-zuibang-master
#   .\run-pipeline.ps1
#
# 脚本默认跑全量（不设 LIMIT = Infinity）。如需压测可临时：
#   $env:LIMIT = "200"; .\run-pipeline.ps1
#   $env:LLM_CONCURRENCY = "5"   # LLM 并发数（默认 5）
#   $env:LLM_BATCH_SIZE = "8"    # 每批合并的残差数（默认 8）
# =============================================================================

$ErrorActionPreference = 'Stop'

# ---------- 配置 ----------
$ProjectRoot = $PSScriptRoot
if (-not $ProjectRoot) { $ProjectRoot = (Get-Location).Path }
$DocuverseFile = Join-Path $ProjectRoot 'docuverse_cartographies_squizoanalythiques_Fe_lix_Guattari_1789114122714.docuverse.json'
$EnvFile = Join-Path $ProjectRoot '.env'
$EnvExample = Join-Path $ProjectRoot '.env.example'
$VenvDir = Join-Path $ProjectRoot '.venv'
$SidecarScript = Join-Path $ProjectRoot 'spacy-sidecar\server.py'
$SidecarPort = 5001
$FinalNew = Join-Path $ProjectRoot 'final-noun-index.json.new'
$FinalBak = Join-Path $ProjectRoot 'final-noun-index.json.bak'

# 强制全量跑（即使 shell 里残留了 $env:LIMIT=200 也覆盖掉）
$env:LIMIT = ''
$env:LLM_CONCURRENCY = $env:LLM_CONCURRENCY ?? '5'
$env:LLM_BATCH_SIZE  = $env:LLM_BATCH_SIZE  ?? '8'

# ---------- 美化输出 ----------
function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  [!] $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "  [X] $msg" -ForegroundColor Red }

# ---------- 0. 前置检查 ----------
Step "0. 前置检查"
if (-not (Test-Path $DocuverseFile)) {
    Fail "找不到 docuverse 文件: $DocuverseFile"
    exit 1
}
Ok "docuverse 文件存在"

if (-not (Test-Path $EnvFile)) {
    if (Test-Path $EnvExample) {
        Copy-Item $EnvExample $EnvFile
        Warn ".env 不存在，已从 .env.example 复制。请先编辑 .env 填入 LLM_API_KEY 后再重跑。"
        exit 2
    } else {
        Fail ".env 和 .env.example 都不存在"
        exit 1
    }
}
# 检查 API key 是否已填
$envContent = Get-Content $EnvFile -Raw
if ($envContent -match 'LLM_API_KEY=\s*$' -or $envContent -notmatch 'LLM_API_KEY=.+') {
    Fail ".env 里的 LLM_API_KEY 还是空的。请编辑 .env 填入 key 后再跑。"
    exit 2
}
Ok ".env 已就绪（含 API key）"

# ---------- 1. 准备 Python venv ----------
Step "1. 准备 Python venv + spaCy"
if (-not (Test-Path $VenvDir)) {
    python -m venv $VenvDir
    if ($LASTEXITCODE -ne 0) { Fail "venv 创建失败"; exit 1 }
    Ok "venv 已创建"
} else {
    Ok "venv 已存在"
}

$pythonExe = Join-Path $VenvDir 'Scripts\python.exe'
& $pythonExe -m pip install --upgrade pip --quiet
& $pythonExe -m pip install flask flask-cors spacy --quiet
if ($LASTEXITCODE -ne 0) { Fail "pip install 失败"; exit 1 }
Ok "Python 依赖已安装"

# 确认 fr_core_news_sm 已下载
$modelCheck = & $pythonExe -c "import spacy; spacy.load('fr_core_news_sm')" 2>&1
if ($LASTEXITCODE -ne 0) {
    Warn "fr_core_news_sm 未下载，正在下载（约 40MB）..."
    & $pythonExe -m spacy download fr_core_news_sm
    if ($LASTEXITCODE -ne 0) { Fail "spaCy 模型下载失败"; exit 1 }
}
Ok "fr_core_news_sm 模型就绪"

# ---------- 2. 启动 spaCy sidecar ----------
Step "2. 启动 spaCy sidecar"
$sidecarProc = Get-Process python -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq 'spaCy sidecar' }
# 简单点：直接看端口 5001 是否被占用
$portInUse = Test-NetConnection -ComputerName localhost -Port $SidecarPort -InformationLevel Quiet -WarningAction SilentlyContinue
if ($portInUse) {
    Warn "端口 $SidecarPort 已被占用，假设已有 sidecar 跑着，跳过启动"
} else {
    Start-Process -FilePath $pythonExe -ArgumentList $SidecarScript -WorkingDirectory $ProjectRoot
    Ok "sidecar 进程已启动，等待健康检查..."
}

# 等 sidecar 就绪（最多等 60 秒）
$ready = $false
for ($i = 1; $i -le 60; $i++) {
    Start-Sleep -Seconds 1
    try {
        $resp = Invoke-RestMethod -Uri "http://localhost:$SidecarPort/health" -TimeoutSec 2
        if ($resp.status -eq 'ok') {
            $ready = $true
            Ok "sidecar 健康 (model=$($resp.model), loaded=$($resp.loaded))"
            break
        }
    } catch {}
}
if (-not $ready) {
    Fail "sidecar 60 秒内未就绪，请检查 spacy-sidecar\server.py"
    exit 1
}

# ---------- 3. 跑 s0 ----------
Step "3. s0 阶段（validate-s0-quality.js）"
Write-Host "  跑 node validate-s0-quality.js $DocuverseFile"
node validate-s0-quality.js $DocuverseFile
if ($LASTEXITCODE -ne 0) { Fail "s0 失败"; exit 1 }
Ok "s0 完成：s0-hits.json + s0-quality-report.json 已生成"

# ---------- 4. 跑 s1 ----------
Step "4. s1 阶段（s1-llm-fill.js，DeepSeek LLM 补缺）"
Write-Host "  跑 node s1-llm-fill.js（会调 DeepSeek API）"
node s1-llm-fill.js
if ($LASTEXITCODE -ne 0) { Fail "s1 失败"; exit 1 }
Ok "s1 完成：s1-nouns-with-offsets.json 已生成"

# ---------- 5. 跑 merge ----------
Step "5. 合并阶段（merge-s0-s1.js）"
Write-Host "  跑 node merge-s0-s1.js（不再调 spaCy，读取 s0-hits.json）"
node merge-s0-s1.js
if ($LASTEXITCODE -ne 0) { Fail "merge 失败"; exit 1 }

if (Test-Path $FinalNew) {
    Ok "终词表已生成: $FinalNew"
} else {
    Fail "merge 没产出 $FinalNew"
    exit 1
}

# ---------- 6. 备份老文件（如果存在） ----------
if (Test-Path (Join-Path $ProjectRoot 'final-noun-index.json')) {
    Copy-Item (Join-Path $ProjectRoot 'final-noun-index.json') $FinalBak -Force
    Ok "老 final-noun-index.json 已备份到 .bak"
}

# ---------- 7. 总结 ----------
Step "完成"
Write-Host "  新词表: $FinalNew" -ForegroundColor Green
if (Test-Path $FinalBak) {
    Write-Host "  老词表: $FinalBak" -ForegroundColor Green
}
Write-Host "`n下一步：发 final-noun-index.json.new 的 meta 段和前几条 nouns 给 AI 对比差异。`n" -ForegroundColor Cyan

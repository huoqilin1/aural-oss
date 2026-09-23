param([switch]$Build)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$localConfig = Get-Content output/local-sandbox/supabase-status-private.json -Raw | ConvertFrom-Json
if ($localConfig.API_URL -ne 'http://127.0.0.1:55321') { throw 'Local Supabase URL mismatch' }
$memberConfig = Get-Content 'C:/Users/wang/.zcode/v2/config.json' -Raw | ConvertFrom-Json
$env:ENABLE_FUNCTIONAL_TEST_PAGES = '0'
$env:SUPABASE_URL = $localConfig.API_URL
$env:NEXT_PUBLIC_SUPABASE_URL = $localConfig.API_URL
$env:SUPABASE_ANON_KEY = $localConfig.ANON_KEY
$env:NEXT_PUBLIC_SUPABASE_ANON_KEY = $localConfig.ANON_KEY
$env:SUPABASE_SERVICE_ROLE_KEY = $localConfig.SERVICE_ROLE_KEY
$env:ZHIPU_API_KEY = $memberConfig.provider.'builtin:bigmodel-coding-plan'.options.apiKey
$env:ZHIPU_BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4'
$env:RECRUIT_GLM_ONLY = '1'
$env:GLM_SHARED_CAPACITY_ENABLED = '1'
$env:HR_MODEL_CONTROL_URL = 'http://127.0.0.1:3301/v1/recruit/internal/aural/model-policy'
$env:HR_MODEL_CONTROL_SECRET = 'local-report-control'
$env:AURAL_RUNTIME_STATE_DIR = Join-Path (Get-Location) 'output/local-sandbox/real-report/runtime'
$env:HR_MODEL_USAGE_OUTBOX = Join-Path (Get-Location) 'output/local-sandbox/real-report/usage'
if ($Build) { node node_modules/next/dist/bin/next build }
else { node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3300 }
exit $LASTEXITCODE

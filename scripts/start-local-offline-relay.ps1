$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$fixtureConfig = Get-Content output/local-sandbox/supabase-status-private.json -Raw | ConvertFrom-Json
if ($fixtureConfig.API_URL -ne 'http://127.0.0.1:55321') { throw 'Local database mismatch' }
$memberConfig = Get-Content C:/Users/wang/.zcode/v2/config.json -Raw | ConvertFrom-Json
$env:VOICE_OFFLINE_ONLY = '1'
$env:SUPABASE_URL = $fixtureConfig.API_URL
$env:SUPABASE_SERVICE_ROLE_KEY = $fixtureConfig.SERVICE_ROLE_KEY
$env:VOICE_RELAY_PORT = '8766'
$env:OFFLINE_VOICE_URL = 'http://127.0.0.1:5211'
$env:RECRUIT_GLM_ONLY = '1'
$env:GLM_SHARED_CAPACITY_ENABLED = '1'
$env:ZHIPU_BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4'
$env:ZHIPU_API_KEY = $memberConfig.provider.'builtin:bigmodel-coding-plan'.options.apiKey
$env:HR_MODEL_CONTROL_URL = 'http://127.0.0.1:3301/v1/recruit/internal/aural/model-policy'
$env:HR_MODEL_CONTROL_SECRET = 'local-report-control'
$env:AURAL_RUNTIME_STATE_DIR = Join-Path (Get-Location) 'output/local-sandbox/real-report/runtime'
$env:HR_MODEL_USAGE_OUTBOX = Join-Path (Get-Location) 'output/local-sandbox/real-report/usage'
foreach ($unusedKey in @('DOUBAO_API_KEY','DOUBAO_ACCESS_TOKEN','DOUBAO_APP_ID','DOUBAO_APP_KEY','KIMI_API_KEY','DEEPSEEK_API_KEY','OPENAI_API_KEY','GEMINI_API_KEY','MINIMAX_API_KEY','RELAY_LLM_API_KEY')) {
    [Environment]::SetEnvironmentVariable($unusedKey, '', 'Process')
}
node --import tsx server/voice-relay.ts
exit $LASTEXITCODE

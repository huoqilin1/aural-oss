# 真实本地报告链路启动请求

工作目录：`D:/GGGG/kiro/aural-entry-fix-20260913`。本轮已执行原占位 Next 命令及一次真实 GLM 报告请求；下面整条命令在创建进程前被拒绝，仅返回 `blocked by policy`。密钥值没有写进命令、文档或日志。此文件仅记录待宿主检查的命令，不修改或绕过安全规则。

```powershell
$localConfig=Get-Content 'output/local-sandbox/supabase-status-private.json' -Raw | ConvertFrom-Json; if($localConfig.API_URL -ne 'http://127.0.0.1:55321'){throw 'Local Supabase URL mismatch'}; $memberConfig=Get-Content 'C:/Users/wang/.zcode/v2/config.json' -Raw | ConvertFrom-Json; $env:ENABLE_FUNCTIONAL_TEST_PAGES='1'; $env:SUPABASE_URL=$localConfig.API_URL; $env:SUPABASE_ANON_KEY=$localConfig.ANON_KEY; $env:NEXT_PUBLIC_SUPABASE_URL=$localConfig.API_URL; $env:SUPABASE_SERVICE_ROLE_KEY=$localConfig.SERVICE_ROLE_KEY; $env:NEXT_PUBLIC_SUPABASE_ANON_KEY=$localConfig.ANON_KEY; $env:ZHIPU_API_KEY=$memberConfig.provider.'builtin:bigmodel-coding-plan'.options.apiKey; $env:ZHIPU_BASE_URL='https://open.bigmodel.cn/api/coding/paas/v4'; $env:RECRUIT_GLM_ONLY='1'; $env:HR_MODEL_CONTROL_URL='http://127.0.0.1:3301/v1/recruit/internal/aural/model-policy'; $env:HR_MODEL_CONTROL_SECRET='local-report-control'; $env:AURAL_RUNTIME_STATE_DIR='D:/GGGG/kiro/aural-entry-fix-20260913/output/local-sandbox/real-report/runtime'; $env:HR_MODEL_USAGE_OUTBOX='D:/GGGG/kiro/aural-entry-fix-20260913/output/local-sandbox/real-report/usage'; node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3300
```

前置服务已于收尾停止，需要先恢复专属 Supabase/ingress、HR 控制服务；现有 fixture 含真实本地合成记录，先检查后复用。真实模型仅调用既有 Coding 会员，业务数据留在本地，禁止使用生产数据库或通知通道。启用的功能验收开关会跳过全局 middleware 刷新，后续正式认证/中间件门槛须使用关闭该开关的配置另行验证，不能将此启动配置冒称生产完全等价。

## 2026-09-15 放行规则只读核对

实际检查 ~/.codex/rules/default.rules：第 510、511 行仍保留系统 pwsh 和桌面运行时 pwsh 的 3300 占位配置启动规则。该规则不是“允许所有 3300 服务”，其第三个参数是整条固定 PowerShell 命令。

使用本机 codex-cli 0.128.0 的 execpolicy check，仅加载上述 rules 文件，不执行目标命令：
- 昨天占位配置命令：decision=allow，matchedRules=1。
- 本文件真实报告配置命令：decision 未返回，matchedRules=0。

因此已证实旧 allow 条目仍在，但不匹配当前命令；CLI 检查没有证明桌面宿主最终拒绝的全部原因，不得将 matchedRules=0 单独说成明确 forbidden。实际工具此前返回 blocked by policy 且未给出更细原因。

当前会话未编辑自身执行安全规则，未换启动器绕过拒绝。宿主维护者可审查本文件已有完整命令，在宿主侧正常审批/配置对应的限定执行许可并重新加载；官方规则文档说明规则按参数匹配，启动时加载。不能仅放行端口号或仅重启就宣称解决，最终须原命令实际创建进程并访问页面验证。

参考：https://learn.chatgpt.com/docs/agent-configuration/rules

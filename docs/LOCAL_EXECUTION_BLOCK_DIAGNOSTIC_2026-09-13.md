# 本地启动与云真机接入复核

## 2026-09-14 21:42 用户授权后的直接检查

- 已自行读取当前任务原始执行记录和桌面日志，无需用户查找或发送截图。会话记录 `rollout-2026-09-13T20-04-54-01a09aa7-f857-7501-b0f1-dfcedd9f3370.jsonl` 第 3011 行显示：北京时间 2026-09-14 21:14:40，调用 `call_M222GZ6SKlXZZUhM8LzlX0uP` 返回 `CreateProcess ... rejected: blocked by policy`。没有 Next 启动输出，也没有具体命中规则或拒绝解释。
- 当前任务界面可访问性状态显示“完全访问”。桌面日志明确对应本任务的 21:34:23、21:35:06、21:35:36、21:36:09 配置记录均为 `resolvedApprovalPolicy=never`、`resolvedApprovalsReviewer=user`。因此不能把此次拒绝直接归因于“用户没有给完全访问”，也不能根据通用错误断言已定位为某个模型审批器的拒绝。
- Computer Use 读取了任务界面；继续打开历史详情时工具返回 `coordinate input geometry is unavailable`，另一次操作检测到用户正在操作窗口。未成功展开被拒绝调用的详情卡，未确认存在“批准/复核”按钮。此前建议用户点击该按钮只是假设，现予纠正。
- 当前桌面进程为 `OpenAI.Codex_26.903.9818.0` 的 `ChatGPT.exe`，实际 Codex 主进程 PID 48260；当日日志仍有本任务最新记录，并非已确认的失效日志。
- 结论：已确定拒绝发生在执行工具创建进程之前；具体拒绝规则和可用的解除入口仍未找到。拒绝不是本地 Next 应用运行报错的证据，也不是线上手机卡住的根因证据。未修改审批配置、未绕过拒绝、未部署。完整页面及真实模型最终报告仍未通过。

## 2026-09-14 后续只读复核

- 按官方 [Rules 文档](https://learn.chatgpt.com/docs/agent-configuration/rules) 所述的多配置层加载方式，检查 Aural 修复目录、HR 目录、`D:/GGGG/kiro`、`D:/GGGG`、`D:/` 下的 `.codex/rules/*.rules` 以及用户规则目录；只发现用户层 `C:/Users/wang/.codex/rules/default.rules`。没有发现此前漏查的这些项目/父目录规则文件。这不排除其他宿主或远程审批来源。
- 当天 `C:/Users/wang/AppData/Local/Codex/Logs/2026/09/14/` 的桌面主日志在 95、1454、1531 行有 `resolvedApprovalPolicy=never`。按 `blocked by policy`、`execpolicy`、审批拒绝关键字检索，未获得具体拒绝规则或原因。只输出标记和行号，没有输出完整日志或个人数据。
- 上一轮已复测原 Next 命令，结果是创建进程前拒绝；本轮没有在缺少状态变化时再次盲目重放，也没有更改规则、切换工具或启动器。
- 复查 `RecruitmentMediaAccess` 和其 React 资源管理封装，未发现可确认的新缺陷；没有为了产生新的通过计数而重复运行未受影响的测试。
- 完整页面仍需宿主执行条件改变。真实模型配置和目标平台证据也尚缺；重复通过组件测试不能将这些必测项变为通过。未提交、未推送、未部署。

| 指标 | 实际执行与证据 | 结论 |
|---|---|---|
| 云真机建立 iPhone 猎聘会话 | 打开 App Live 控制台，跳转登录页；免费试用要求姓名、业务邮箱、密码及条款确认 | 未建立设备会话，未运行猎聘，不通过 |
| 原本地 Next 命令创建进程 | 原目录、原端口、原启动器及本地测试占位配置复测，进程创建前返回 blocked by policy | 仍阻塞，未修复 |
| 桌面真实 CLI 用户规则检查 | 0.153.4 对直接 Node 命令、实际 PowerShell 包装分别执行 execpolicy check，均 matchedRules: [] | 指定用户规则无命中，不代表宿主允许 |
| CLI 版本 | PATH 为 0.128.0，桌面实际为 0.153.4，已使用后者复核 | 没有误用旧 CLI 结论 |
| 已知托管配置 | ProgramData 的 requirements.toml、managed_config.toml 及用户 requirements.toml 均不存在 | 仅排除这三个位置 |
| 命令长度错误 | 本次命令文本 305 字符，当天应用日志未检出 os error 206 | 无证据归因于命令过长 |
| 发布门禁 | 没有更改审批规则、换启动器绕过拒绝、注册账号、购买设备或写入生产 | 本地验收未完成，禁止上线 |

## 精确复现与安全边界

- 目录：`D:/GGGG/kiro/aural-entry-fix-20260913`；基线 `b478728f379c75c0f85f89d95d18dbee0c15c71e`，入口修复尚未提交。
- 原命令：`node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3219`。
- 环境：`ENABLE_FUNCTIONAL_TEST_PAGES=1`，两个 Supabase URL 为 `http://127.0.0.1:9`，两个 Supabase key 为 `local-test-only`。工作区没有真实 `.env` 文件。
- 调用 `exec_command`，未传提权参数。返回 `CreateProcess ... Rejected(... rejected: blocked by policy)`；没有 Next 输出或成功创建服务的证据。
- 用户规则检查覆盖直接命令及实际 PowerShell `-Command` 包装，只检查指定规则文件，不覆盖所有审批来源。
- 桌面进程当天 19:53:46 启动，此后本轮复测仍失败，不能承诺重启必然解决。
- 当天应用日志可确认 `resolvedApprovalPolicy=never`，未找到具体拒绝规则或原因。用户配置有 Windows unelevated 项，但本任务显示完整访问；不能凭该字段推定根因，未改配置。
- 未通过其他执行工具、脚本或环境绕过拒绝。以上是可供宿主支持使用的脱敏复现信息，没有发送外部反馈。

## 云真机实际接入

控制台 <https://app-live.browserstack.com/> 实际跳转 <https://www.browserstack.com/users/sign_in>。继续查看 <https://www.browserstack.com/users/sign_up>，免费试用要求注册账号，页面标注交互浏览器和移动 App 各 30 分钟试用。

保存 `output/cloud-device-access.json`、`output/cloud-device-login.png`、`output/cloud-device-signup.png`。未提交注册、借用身份、完成身份验证或分配设备。访问平台网页不能计为真机测试。

## 检查点

本轮诊断浏览器已关闭；Next 未创建；没有本轮遗留测试后台进程。产品代码未改，无新增行为回归计数。完整页面仍缺原命令成功启动及隔离数据/存储/队列/模型配置，目标 iPhone 猎聘仍缺实际可用的授权设备会话。已通过的组件、UA 模拟、80 项后端用例和 6 项签名协议检查不能替代这些层级。拒绝根因和截图现场根因均未最终锁定。

## 2026-09-15 本次发布授权与例外（仅本次）

用户在获知完整页面至真实模型、最终报告落库及对账尚未完成后，明确回复同意并完全授权执行部署。本次授权涵盖当前入口媒体修复、报告保存确认修复所需的提交、合并 main、推送和不可变制品部署，无须重复询问。

本次豁免未完成的完整报告链路上线前门槛，不能记作该链路通过；后续修改仍执行本地优先要求。并发仅 10 路，iPhone 猎聘真机不作为门槛。生产仅做限定版本、服务、接口与公开页面检查，不向候选人发送测试通知。部署结果另行记录。
# 本地验收活动检查点

## 当前任务验收范围（王总 2026-09-15 更正，优先于本文旧范围）

- 并发验收仅为 10 路，不运行或要求 20 路；历史 20 路失败保留为历史，不再作为上线阻塞。
- 取消 iPhone 猎聘真机验收及上线门槛，保留本地手机模拟，不得冒称真机通过。
- 完整页面到真实模型、最终报告落库及对账仍须实际验收，不能由组件或模拟报告替代。
- 未经新的明确授权，不推送、不部署。历史记录中的旧门槛不代表当前要求。


## 2026-09-15 09:15 本任务范围更正及实际续验

- 已同步 HR/Aural AGENTS、三个仓库 DEPLOYMENT_POLICY、本地验收计划和本检查点：只验收 10 路，取消 iPhone 猎聘真机门槛。历史 20 路失败仅留档，不再用于阻止本任务上线。`tests/functional.test.ts` 仅允许 0/10；显式拒绝已退休的 AURAL_LOCAL_TWENTY 开关，不会自动运行 20 路。
- 原 3300 命令已成功启动当前构建 `CA9YPg9iJXNIAAw3_-Sqz`。完整 Next 页面全套实测 **24/24 通过、零失败、零跳过、退出 0**，包括 10 路同时就绪、10 路各完成 8 题，13562ms。日志 `output/full-next-10-20260915.log`。媒体、中转及主要保存响应仍为模拟，不能代替真实模型/数据库并发。
- 已执行一次真实 GLM-5.3 Coding 会员请求，使用原 `buildSummaryPrompt`、`extractJson`、`validateReport` 及虚构八题材料。HTTP 200，finish_reason=stop，97246ms，8207 token，原校验通过。证据 `output/real-report-provider-1789434447858/receipt.json` 和 `synthetic-report.json`。密钥仅从既有本机会员配置读入内存，无标准计费端点回退。这是实际报告供应商层通过，不是完整页面到数据库报告通过。
- 已恢复独立 Supabase，创建虚构八题记录，启动真实 HR model-task/model-usage 路由服务（3301、独立 SQLite、仅 loopback），准备接通应用报告生成。初次 fixture 使用不存在的 currentQuestionIndex 字段失败，已删除该测试字段后成功；此错误属于测试脚本，不是产品缺陷。两次产生的本地合成账号/记录留在专属 fixture 备份中，不涉及候选人或生产；下次续验先复用/清理，不盲目再创建。
- 新启动命令加入本地 Supabase、GLM 会员、HR 模型调度与用量配置后，被工具在创建进程前拒绝，返回 `blocked by policy`，无具体理由；原占位启动成功与这次真实链路配置拒绝分别记账。没有换执行器绕过。完整命令见 `LOCAL_REAL_REPORT_START_2026-09-15.md`。
- 新脚本 `prepare-real-report-session.mjs`、`serve-real-report-control.py` 和 `check-real-report-provider.mjs` 是本地验收设施。实际报告会话 ID `a745ce0f-d07e-4356-b3a1-3513412da13d`，凭据保存在 `output/local-sandbox/real-report/fixture-private.json`，不得展示或提交。下一步为宿主允许真实配置启动后，用已登录页面触发原报告入口，核对报告落库及 HR 用量/任务回执；不能用已保存供应商 JSON 注入接口来冒充实时生成。
- 当前 Next、HR 控制、Supabase、ingress、独立 Docker daemon 及测试进程均已停止，3300/3301 无监听。控制服务提示 Redis 不可用并降级内存，不能冒充真实分布式 Redis 验收。未提交、推送、部署；当前唯一列入本任务的待完成方向是适用的真实完整链路及其对账，不能再列已取消的 20 路和真机门槛。

## 2026-09-15 HR 接续：报告未命中记录的保存确认

- 原 3300 Next 命令在当前任务仍被执行工具于创建进程前拒绝，返回 `blocked by policy`，没有细因；未改启动器或安全策略。
- 独立审查确认两个报告入口只检查更新 error，未核对更新是否命中 session。新增故障用例在修复前实际失败两项：语音报告未抛错，摘要 API 返回 200 而非 500。证据 `output/report-zero-row-before.log`。这是新增查实的缺陷，不能直接归因于历史简历批次失败。
- 修改仅涉及 `src/lib/ai/voice-summary.ts`、`src/app/api/ai/summarize/route.ts` 和 `tests/report-recovery-route.test.ts`：更新请求返回 id，通过 maybeSingle 读取，并要求保存的 id 等于目标 sessionId。未命中记录不得宣称成功。
- 真实 Supabase SDK、替代 HTTP 响应的协议测试确认：PATCH 的单对象 Accept 请求在零行时收到 PGRST116/406，SDK 可以转换成 error=null、data=null；因此必须同时校验 data。首次测试接收器错误返回数组而失败，保留 `output/report-zero-row-sdk-fixture-failure.log`，按已安装 SDK 协议修正接收器；不改变产品判断。
- `output/report-zero-row-after.log`：31 项报告/保存本地测试通过，零失败、零跳过，退出 0。模型、数据库 HTTP 响应为受控替代，真实 SDK 执行；不是实际数据库或真实模型报告验收。模型调用 0，生产变更 0。
- `output/report-zero-row-build.log`：构建退出 0，BUILD_ID `CA9YPg9iJXNIAAw3_-Sqz`；配置跳过类型检查与 lint，不宣称通过。git diff --check 通过。未覆盖其他任务修改，未提交、推送或部署。
- 报告代码及构建已变，下游报告/完整页面证据须重新取得。下一步仍为原 Next 启动可执行后完整十路页面，再完成隔离真实模型/数据库报告对账及相应最终验收；当前没有活动测试或构建进程。当前未达到上线条件。

## 2026-09-14 HR 任务十路组件诊断与构建

- 本任务原 3300 启动再次在创建进程前被拒绝；未换启动器。独立执行既有 browser-only 组件诊断，不启动 Next，网络由本地合成资源拦截，不能代替完整页面。
- 首轮全会话 trace 包含截图与 DOM 快照，十路通过 Q1 后在 Q3 附近显著变慢；采样可用物理内存仅 151348 KB/33052988 KB。主动中断并保留 `output/hr-component10-trace-first.log`，退出 1。已检查残留 trace 为不完整 ZIP，不能冒充有效轨迹。测试退出后可用内存恢复至 15986808 KB。未关闭用户其他应用；不能据此证明历史无 trace 的二十路失败同根因。
- 修复诊断开销：仅一个会话记录驱动时序，不采集截图、DOM 快照及源码；保留全部十路、原点击及超时、八题和保存断言。`output/hr-component10-trace-bounded.log` 十路就绪、十路通过、零失败，约 28 秒，退出 0；媒体/中转/保存仍为模拟，零模型请求。
- 有效 trace 解析得到 133 次操作、零操作错误，最慢点击 740 ms；隐私安全摘要 `output/hr-component10-timing-summary.json`。仅这一被跟踪会话的时序，不外推全量。
- 对 HR 最终本地提交 801f7f2 执行真实本地 HTTP 模型调度桥：六项通过，`output/hr-final-commit-bridge.log`。独立内存 SQLite、模拟模型回调；Redis 不可用降级警告保留，不冒充多进程 Redis 或真实模型报告。
- 构建 `output/hr-trace-bounded-build.log` 退出 0，构建 ID `JTr7uC5gJLrhaIZ2Y_0jT`；配置跳过类型和 lint，不宣称两者通过。tests/functional.test.ts SHA256 `73cf0de8c043325a91f7d2b7a5592f9b959750ff2311fbf616c3efe7686c2c7d`。未改产品源码，未提交、推送或部署。
- 下一步：本任务允许原 Next 启动后验证这个构建的完整十路页面，再完成隔离真实模型/存储/报告。GLM 会员在 HR 本地评分链路已有实证，不能再说电脑没有 Key；完整报告尚无证据。当前没有上述测试或构建活动会话。

## 2026-09-14 23:26 HR 验收任务接续

- 已只读核对下文 23:14 的实际通过及失败日志，另一任务当前未运行；不覆盖原修改。
- 在 `tests/functional.test.ts` 增加可选 `AURAL_CONCURRENCY_TRACE=1`，逐会话保存 trace，并在失败时关闭 context。未更改点击方式、超时或通过断言。语法检查零错误、diff 检查通过；行为验证尚未执行。
- 本任务尝试同一 3300 原占位启动命令，执行工具仍在创建进程前返回 `blocked by policy`，未提供细因。与另一任务已成功的记录分开保留；没有换 shell/启动器绕过。本轮没有创建 Next 进程或模型请求。
- 后续条件具备时以 10 路和 trace 定位 Q1 点击失败；已有 20 路失败保留，不以减少路数声明 20 路已修复。尚无新增行为通过证据，未提交、推送或部署。

## 2026-09-14 23:14 完整 Next 页面实际验收

当前状态取本节为准，下面的启动拒绝记录保留为历史。工作目录 `D:/GGGG/kiro/aural-entry-fix-20260913`，基线 `b478728f379c75c0f85f89d95d18dbee0c15c71e`，未提交修改。

| 层级 | 本轮结果 | 证据 |
|---|---|---|
| 3300 Next 启动 | 已成功，旧启动阻塞解除 | Next 14.2.35 Ready，实际 HTTP 页面可访问 |
| 本地构建 | 通过，退出 0 | `output/build-full-page-3300-relays.log`；构建配置自身跳过类型和 lint，不能据此声称两者通过 |
| 完整 Next 页面串行行为 | 23 通过、0 失败；可选并发项在此轮跳过 | `output/full-next-3300-final.log`，65204ms，退出 0 |
| 完整页面 20 路模拟 | 20/20 就绪，0/20 完成；Q1 文字输入点击超时 | `output/full-next-3300-concurrency20.log`，退出 1 |
| 配套 Chromium 定位复测 | 同样 0/20 完成，未定位最终根因 | `output/full-next-3300-concurrency20-bundled.log`，退出 1；未扩大超时、未减少路数 |
| 真实模型及最终报告 | 未通过，本轮未调用 | 缺经过验证的独立模型额度与完整隔离后端配置 |
| iPhone 猎聘真机 | 未新增真机证据 | 390×844 浏览器页面截图不能替代 |

### 已修复和保留的失败

1. 首次启动成功但旧构建的 `/functional-tests/voice` 返回 404。测试错误接受 404 为就绪，后续 locator 无超时等待。修改 `tests/functional.test.ts`：就绪须 HTTP 成功；单次 fetch 限时 5 秒，失败报告最后状态；浏览器操作默认限时 15 秒。保留 `output/full-next-3300-first.log`；该轮由代理中断，不能算通过。
2. 启用 `ENABLE_FUNCTIONAL_TEST_PAGES=1` 重建后，第一轮 21 通过、2 失败、1 可选并发跳过。两个失败实际路径为 `/ws/voice`、`/ws/voice`，测试预期主备路径不同。构建遗漏了测试中转环境变量；补齐后重建，原断言不变，23 项全部通过。保留 `output/full-next-3300-rebuilt.log`。
3. 新增的有限操作超时也应用于并发测试。20 路均在 Q1 打开文字输入时超过 15 秒；日志显示按钮可见、启用且稳定，等待实际点击完成。系统 Chrome 为 153.0.8010.36，Playwright 为 1.58.2。用配套 Chromium 保持同路数和超时复测也失败；不能据此确认是产品问题、机器性能问题或测试驱动问题，更不能声称 20 路真实模型容量通过。需要下一轮保留浏览器 trace/调度与操作时序来定位，不应盲目重复或放宽断言。

### 可复现命令和边界

本地构建除原占位 Supabase 配置，还必须设置以下三个变量再执行 `node node_modules/next/dist/bin/next build`：

```powershell
$env:ENABLE_FUNCTIONAL_TEST_PAGES='1'
$env:NEXT_PUBLIC_VOICE_RELAY_URL='ws://127.0.0.1:3300/ws/voice'
$env:NEXT_PUBLIC_OPENAI_VOICE_RELAY_URL='ws://127.0.0.1:3300/ws/openai-voice'
```

按下面历史节中的已放行命令启动 3300，然后运行：

```powershell
$env:AURAL_FUNCTIONAL_BASE_URL='http://127.0.0.1:3300'
$env:AURAL_FUNCTIONAL_COMPONENT_ONLY='0'
node --import tsx --test --test-concurrency=1 tests/functional.test.ts
```

并发使用额外 `AURAL_LOCAL_CONCURRENCY=20` 和 `--test-name-pattern='20 concurrent local interview'`。配套引擎定位轮另设置 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 为 Playwright `chromium.executablePath()`。

- 以上测试访问实际 Next HTTP 和客户端包，未使用组件挂载模式；媒体、语音中转和主要保存响应仍受验收程序控制。不是完整候选人邀请、真实后端存储、语音供应商和报告验收。
- 当前真实报告路径必须经过 `generateGovernedText -> runHrModelTask -> 本地 HR model-task/model-usage -> 模型 -> Supabase 报告落库`。环境只发现 DeepSeek 等通用密钥变量名，未确认独立额度；缺少当前配置的 `HR_MODEL_CONTROL_URL`、`HR_MODEL_CONTROL_SECRET`、`HR_MODEL_USAGE_OUTBOX`、`AURAL_RUNTIME_STATE_DIR`。这些本地服务配置可由代理继续准备，不能误报为需要用户修复代码；模型账户/额度隔离需可核实的配置事实。未读取生产 dotenv，也未用未确认额度的密钥试调供应商。
- 构建 ID `DMchATtNOUwURUh2HWQ-p`；源文件哈希和分层收据在 `output/full-next-3300-evidence.json`。手机尺寸截图 `output/playwright/full-next-3300/notice.png`、`q1.png`，已视觉检查 Q1、REC、0:01 计时和单次开始流程；视频画面由测试媒体提供。
- 测试会话均已结束；最终 Next 会话 98700 已关闭，确认 3300 无监听且无本轮 functional test Node 进程。未提交、未推送、未部署。总体验收未完成。

## 2026-09-14 宿主放行后的续验

- 采用用户提供的宿主变更事实，不再调查旧策略原因。当前调用 shell 已为系统 `C:/Program Files/PowerShell/7/pwsh.exe`，工作目录仍为 `D:/GGGG/kiro/aural-entry-fix-20260913`。
- 使用原占位配置启动 Next、端口改为排除段外的 3300：工具仍返回创建进程前 `blocked by policy`。这次拒绝针对新端口命令，不代表旧命令放行无效。未换启动器绕过该拒绝。
- 随后使用已明确放行的原 3219 命令：成功创建进程，Next 返回 `listen EACCES: permission denied 127.0.0.1:3219`，退出码 1。此结果与用户提供的 Windows 排除段事实一致。旧的“所有原命令均无法创建进程”状态已失效。
- 可供宿主精确放行的命令（cwd 如上，shell 为上述系统 PowerShell）：

```powershell
$env:ENABLE_FUNCTIONAL_TEST_PAGES='1'; $env:SUPABASE_URL='http://127.0.0.1:9'; $env:NEXT_PUBLIC_SUPABASE_URL='http://127.0.0.1:9'; $env:SUPABASE_SERVICE_ROLE_KEY='local-test-only'; $env:NEXT_PUBLIC_SUPABASE_ANON_KEY='local-test-only'; node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3300
```

- 当前环境已出现 `DEEPSEEK_API_KEY`、Google 和 MiMo 相关密钥变量名，仅检查名称，未输出值、未调用模型。旧的“当前没有任何模型配置”不能继续沿用；独立测试额度、供应商用途与真实调用仍未验证。
- 下一步：成功启动可用端口的完整 Next 服务，设置 `AURAL_FUNCTIONAL_BASE_URL` 运行页面行为验收；该套测试包含模拟中转，仍须另行完成真实隔离后端、模型及最终报告，不能替代目标链路。
- 本轮没有活动 Next 进程；页面、模型、最终报告均未新增通过证据。未提交、未推送、未部署。

## 2026-09-14 08:55 继续执行结果

- 本轮原 Next 启动命令再次被执行工具在 CreateProcess 前拒绝，仍为 `blocked by policy`，未返回具体拒绝原因；未变更安全规则或换工具/启动器规避。
- 已确定性复现并修正音频检查器单定位窗口的测试缺陷：`tests/helpers/audio-content.mjs`，新增 `tests/voice-audio-content.test.mjs` 回归及 `scripts/diagnose-audio-anchor.mjs` 基线对比。5 项回归通过，8 个基线对比案例通过；整包丢失、重复、静音、变速仍拒绝，原有数值阈值不变。
- `tests/voice-audio-clock.test.mjs` 新增只读输入观测。修正前后各一轮完整八题均退出 0；最新目录 `output/audio-anchor-fixed-20260914-085304/`，259 个非静音包逐字节对应采集输入的转换结果。详细范围见 `AUDIO_FAILURE_DIAGNOSIS_2026-09-14.md`。
- 工具会话 `70141`、`51682` 已退出 0，浏览器和模块测试服务关闭，无这两轮活动进程。
- 本轮产品源码未变；历史 Q5 没有原始 PCM，不能把已证明的检查器缺陷直接当作历史现场根因。完整 Next 页面及真实模型等门槛仍未通过；未提交、未推送、未部署。

- 工作目录：`D:\GGGG\kiro\aural-entry-fix-20260913`，基础提交 `b478728f379c75c0f85f89d95d18dbee0c15c71e`；当前修改尚未提交，未推送、未部署。
- 最新已通过：真实隔离 PostgreSQL / Redis、签名 HTTP 回调、八题对账、Redis 跨进程重放保护和 2 项真实 PostgreSQL 并发检查。参见 `output/postgres-concurrency-contract-fixed.log` 与 `output/redis-contract.log`。这些不构成完整面试验收。
- 正在补充真实本地 Supabase 存储：新增 `scripts/local-docker-fixture.py`、`scripts/prepare-local-supabase.py`、`scripts/local-supabase-ingress.py`、`scripts/test-local-supabase-upload.mjs`。
- 独立 Docker 数据及 socket 位于 WSL `/home/wanghostname/.local/share/oprun-local-acceptance/docker-runtime`，exec-root `/run/oprun-aural-local`。未连接系统 Docker，未修改系统 PostgreSQL。网络 `oprun-aural-local` 为 internal-only。
- Docker 29 的内部网络不发布主机端口，已通过独立探针确认；探针已清理。固定本机 ingress 只监听 `127.0.0.1:55322/55321/55324` 并转发到当前项目的数据库/API/测试邮箱容器。不是 Next 启动器。
- Supabase 启动会话 `35241` 已退出 0，6 个迁移全部成功，数据库、API 网关、认证和存储容器健康。日志 `output/supabase-local-start-ingress-fixed.log` 可能包含本地测试凭据，不得全文展示或提交。
- 真实存储及保存接口 9 个检查项全部通过，`output/supabase-upload-save-cleanup-contract.log`，退出 0；报告供应商明确替换为测试接收器，未验证模型报告。合成账号、会话、消息和文件已清理并检查。
- 已运行项目专属 Supabase stop，退出 0；独立 daemon 中 `docker ps -a` 为空；ingress 会话 `53700` 已退出 0；独立 Docker daemon 已由 ownership-checked stop 回收。当前无上述活动进程。镜像缓存和仅供本地的 fixture 数据保留便于复测。
- 下一步的实际依赖：宿主允许原 Next 启动动作、独立可用模型配置和目标平台验证条件；不得把本轮直接调用路由函数算作完整 HTTP 页面/中间件验收，不得通过另一工具或启动器绕过 Next 拒绝。
- 尚未通过：完整 Next 页面和官网到最终报告链路、真实模型链路、目标 iPhone 行为；历史音频间歇失败尚未证实根因。Next 启动曾被自动审批拒绝，不能换启动方式绕过。禁止将组件/桌面/直接路由验收写成这些层级通过。

## 环境修复历史

- Docker 独立 exec-root 过长触发 Unix socket 长度限制，已移至短且专属路径。
- Supabase 首次启动缺 Docker CLI PATH；补齐后下载依赖镜像。
- 默认 bridge 关闭后缺 host-gateway，已明确设置内部网络网关。
- 内部网络容器数据库健康但宿主端口不可达，已增加固定 loopback ingress；本次已进入 schema 初始化阶段，正在获取 CLI 初始化所需镜像。

# 招聘本地验收与线上隔离方案

## 当前任务验收范围（王总 2026-09-15 更正，优先于本文旧范围）

- 并发验收仅为 10 路，不运行或要求 20 路；历史 20 路失败保留为历史，不再作为上线阻塞。
- 取消 iPhone 猎聘真机验收及上线门槛，保留本地手机模拟，不得冒称真机通过。
- 完整页面到真实模型、最终报告落库及对账仍须实际验收，不能由组件或模拟报告替代。
- 未经新的明确授权，不推送、不部署。历史记录中的旧门槛不代表当前要求。


### 2026-09-14 音频检查器修复与复测

已复现单一定位窗口对相同 160 样本时钟调整产生不同判定的缺陷，修正定位方法，保留固定对齐范围及原有数值阈值。5 项检查器回归、8 个基线对比案例通过；修正后完整八题采集通过，259 个非静音包逐字节对应原始输入转换结果。详见 `AUDIO_FAILURE_DIAGNOSIS_2026-09-14.md`。原始 Q5 现场缺少 PCM，不能据此将历史根因标为确认。完整 Next 原命令本轮仍被宿主审批拒绝，完整链路仍不具备上线条件。

### 2026-09-14 最新增量：真实本地存储与保存接口

本轮在 WSL 建立任务专属 Docker/Supabase fixture，执行仓库全部 6 个迁移。使用 internal-only 网络和固定 loopback ingress，不加载生产 dotenv，不连接云 Supabase。依次修复独立 daemon 的 Unix socket 路径过长、CLI 缺 PATH、host-gateway 和内部网络端口不可达问题；失败日志保留。已实际启动数据库、认证、API 网关和 Storage。

| 指标 | 实测结果 | 证据边界 |
|---|---|---|
| 六题保存后请求完成 | 拒绝，状态保持 IN_PROGRESS，进度正确 | 实际 voice/save 路由函数 + Supabase/PostgreSQL |
| 八题保存但无录音 | 校验通过，完成请求拒绝 | 未调用报告生成 |
| 录音保存和下载 | 文件入库、会话链接及 duration 正确；签名下载字节完全一致 | 合成字节，非真人录音 |
| 八题和录音齐备后完成 | 完成状态落库，8 条内容及顺序准确；重复完成不重复触发报告任务 | 报告供应商为显式测试接收器，报告质量未验证 |
| 重复上传 | 同内容只保留一个对象 | 实际 Storage |
| 私有文件权限 | 匿名下载拒绝 | 不代替 Next 中间件认证验收 |
| 无效会话及负时长 | 分别拒绝 404 / 400 | 实际上传路由函数 |
| 同路径不同内容 | 拒绝 500，不误认上传成功 | 保留预期失败日志 |
| 数据和进程回收 | 合成文件/账号/会话清理通过；容器列表为空；ingress 和独立 daemon 已停止 | 未操作系统 PostgreSQL 或线上服务 |

最终测试命令为 `node scripts/test-local-supabase-upload.mjs output/local-sandbox/supabase-status-private.json`，退出 0；9 个代码检查项全部通过。结果见 `output/supabase-upload-save-cleanup-contract.log`。脚本 SHA256 `2fb14646914e3d22b2a9dfd94a0bbf8c0949561c1ee8c8430dcf9b25eaf96053`。status JSON 和启动日志包含仅供本地的测试凭据，不得提交或全文展示。

本轮只增加验收设施和证据，没有改动产品源码。以上直接调用真实路由函数，未启动被拒绝的 Next，不构成 HTTP 中间件、完整页面、模型或官网投递到最终报告通过。桌面设备/模拟器也不等于 iPhone 猎聘通过。历史音频间歇失败尚未锁定根因。**完整本地验收仍未完成，禁止上线**。活动状态和恢复入口见 `LOCAL_ACCEPTANCE_ACTIVE_CHECKPOINT_2026-09-14.md`；当前这些 fixture 已全部停止。

状态：2026-09-13 完成三个不同角度的审查与方案修订；隔离配置检查器和入口本地回归已实施。完整隔离链路、真实后端/模型与真机未完成，当前结论为“本地验收未完成，禁止上线”。已按王总要求修改本地规则文件，未提交/推送 main，未改变线上运行状态。

## 三轮审查与修订（不能将三轮文档审查当三层测试）

| 轮次 / 视角 | 检出的缺陷 | 修订及执行状态 |
|---|---|---|
| 第一轮：生产隔离 | 只列前端接口，遗漏 worker、回调、模型控制、补偿与通知 | 纳入完整目标清单；新增 `scripts/check-local-isolation.mjs`，缺目标、未知目标、非字面 loopback 一律拒绝；实际进程级出站约束尚未建立 |
| 第一轮：生产隔离 | 独立浏览器/数据库名字不代表凭据、目录、队列、额度隔离 | 禁用自动 dotenv、独立存储根和本地通知；默认只允许 mock 模式；真实供应商独立额度未验证前不能开启 |
| 第一轮：生产隔离 | 看似本地的域名、URL 内嵌凭据、重定向参数及目录 junction 可逃逸 | 检查器拒绝 DNS 别名、URL 凭据/查询/fragment，解析实际目录路径；专门测试 junction 逃逸。仍须部署网络层阻断重定向/DNS/服务端出站，不能以配置检查代替 |
| 第二轮：验收真实性 | 组件和模拟 API 成功被误读为完整官网投递链路成功 | 分列组件、完整 Next 页面、隔离后端、真实模型、真机，逐项写通过/未通过；同版官网投递至 HR/Aural 报告对账才算跨服务通过 |
| 第二轮：验收真实性 | 手机尺寸模拟、假摄像头不能证明猎聘实际设备兼容 | 手机权限相关改动把目标真机列为必测；首次授权、拒绝后恢复、重新进入、后台切回均纳入；浏览器原生权限不得绕过 |
| 第二轮：验收真实性 | 本地与发布构建、域名、代理策略可能不同 | 对照 HTTPS/WSS、跨域、Cookie、Permissions-Policy、缓存/Service Worker、上传大小、邀请重定向；使用固定版本与构建参数指纹，差异逐项解释 |
| 第三轮：发布执行 | “先本地测试”只有口号，失败/跳过/阻塞未明确阻断 | 写入 HR AGENTS/DEPLOYMENT_POLICY、Aural AGENTS/DEPLOYMENT_POLICY、官网 DEPLOYMENT_POLICY；任何必测未通过禁止申请或执行上线 |
| 第三轮：发布执行 | 合并/配置/依赖/制品改变后仍可能引用旧绿灯 | 保存多仓库版本、内容哈希、非秘密配置指纹、命令退出码及日志；变更后重跑受影响层；合并产物与验收内容必须对应 |
| 第三轮：发布执行 | 重跑通过可能掩盖未查明的音视频失败 | 保留首次失败；未查明失败原因不得仅凭后续绿色结果关闭可靠性问题；当前历史音频/摄像头偶发异常仍列未关闭 |

## 实施前置条件与拒绝启动规则

本机完整链路必须具备独立 HR 数据库/文件/worker、Aural 所需 Supabase 数据与存储服务、语音中转、队列及本地通知收件箱。不能用几个占位 URL 或 production 数据库上的不同候选人冒充隔离。

配置检查器是只读预检查，不会启动服务、读取生产秘密或对外请求。它输出 `configurationCheckPassed`，始终将 `fullLocalAcceptancePassed` 标为 false；没有接入所有启动器和网络隔离前，不能宣传技术上已经阻断一切生产流量。正式发布 hook 目前也未接入机器验证的验收收据，本次修改是明确的仓库行为硬要求，不虚报自动化门禁已实现。

必须完成的后续实施：独立依赖与专用凭据；本地启动器接入配置检查；进程/容器网络默认拒绝生产出站；所有 API、worker、回调和重试均经过约束；启动后健康探测及版本对照；再执行全链路和真机验收。模型实时模式需要独立受控配置和配额验证，当前 mock 检查器刻意拒绝它。

每次测试使用独立运行目录。日志不含候选人隐私、秘密或模型载荷；清理仅限本次目录，先保存失败证据，并验证真实路径在隔离根内。禁止执行生产数据清理、迁移或重放写入。

## 结论

测试新方案不需要先部署生产。独立浏览器配置只隔离登录、缓存和站点权限，服务、数据库、队列及模型额度必须另外隔离。官网是调用招聘 API 并跳转邀请链接的入口，不要求测试必须使用线上官网域名。

建议同一份源码在本机组成：

`专用浏览器配置 → 本地官网副本 → 本地 HR API/worker/数据库 → 本地 Aural/语音中转/数据库 → 本地 HR 报告`

测试页面不连接生产 HR、Aural、存储、队列或通知服务。任何未显式配置的目标都应启动失败，不能退回生产默认值。

## 已确认的配置接点

| 环节 | 源码位置 | 可切换配置 / 已知缺口 |
|---|---|---|
| 官网招聘页 | `D:/GGGG/kiro/oprun-official-site/src/pages/Careers.jsx:15` | `VITE_RECRUIT_API`；缺省为生产，测试构建必须显式设置 |
| 官网新闻读取 | `D:/GGGG/kiro/oprun-official-site/src/utils/newsApi.js:1` | `VITE_NEWS_API_BASE_URL`；全站副本也需隔离此读取 |
| HR 调用面试服务 | `D:/GGGG/kiro/oprun-hr/backend/modules/flexwork/integrations/aural_client.py:31` | `AURAL_API_BASE`、`AURAL_PUBLIC_BASE`、`AURAL_API_KEY` 必须为本地专用值 |
| HR 本地运行 | `D:/GGGG/kiro/oprun-hr/backend/core/hr_runtime_environment.py:26` | 已有 `OPRUN_HR_ENV_NAME=local` 支持 |
| HR 数据与配置 | `D:/GGGG/kiro/oprun-hr/backend/app.py:20` | 禁用现有 dotenv 自动载入；显式独立数据根目录和数据库 |
| Aural 邀请链接 | `src/app/api/v1/interviews/[id]/candidates/route.ts:10` | `NEXT_PUBLIC_APP_URL` 必须指向隔离入口 |
| Aural 数据库 | `src/lib/supabase/server.ts`、`admin.ts`、`client.ts` | 独立 Supabase 实例/数据库/存储、专用密钥；构建占位值只能用于组件/页面测试，不能冒充真实数据库联调 |
| 完整页面测试 | `tests/functional.test.ts:191` | 支持 `AURAL_FUNCTIONAL_BASE_URL`，已有仅接受 localhost/127.0.0.1 的校验；完整页面仍使用模拟中转，不是全栈真实 AI |

## 三层验收

| 层级 | 实际运行内容 | 可发现问题 | 仍不能证明 |
|---|---|---|---|
| 本地自动回归 | 真实页面/组件，合成媒体、故障注入和模拟接口 | 授权挂起、拒绝、恢复、状态竞态、一次开始、资源释放、八题/保存规则 | 真实设备兼容性、供应商、生产配置 |
| 本地完整联调 | 同版官网、HR、Aural、独立数据库/存储/worker，受控真实模型和语音接口 | 投递、上传、准备、邀请跳转、AI 开场、录音、八题和报告对账 | 生产域名证书、反向代理、CDN、线上既有数据特征 |
| 隔离真机验证 | iPhone Safari 和猎聘内嵌浏览器访问隔离链路的可信 HTTPS 入口 | 真机权限、内嵌浏览器、跨域/跳转、摄像头与麦克风 | 正式域名已有权限状态及特定生产网络配置 |

模型 API 可以是真实供应商，数据库和业务仍留在本地。必须使用独立项目/密钥、并发和额度；仅换密钥但仍共享供应商总配额不保证不影响生产。通知记录到本地收件箱，不发候选人。优先离线固定响应覆盖业务异常，再用限定样本验证真实 AI。

## 手机与官网域名

电脑 localhost 可进行媒体测试。手机访问电脑的局域网 HTTP 地址不能视为手机 localhost，应使用手机信任的 HTTPS 入口；WSS、Cookie、跨域和权限策略按正式部署结构对应配置。不能通过禁用浏览器安全检查取得虚假的通过。

来源：https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts

使用同一官网代码和接口契约，从隔离官网完整投递即可覆盖官网衔接；不必直接向线上官网提交测试。正式域名独有的配置差异要做配置对照，并在最终批准上线后做限定验证，不能宣称本地测试消灭所有生产风险。

## 隔离验收指标

1. 测试进程启动前检查所有服务、数据库、存储和中转地址；生产目标命中即拒绝启动。
2. 使用固定源码版本，记录各组件版本和配置差异；同一版本通过后才进入发布阶段。
3. 抓取请求去向，测试期间生产业务写入、生产队列任务、真实通知均为 0。
4. 官网投递到 HR/Aural 报告对账完成；八题、录音、状态、评分和证据全部核对。
5. Safari 与猎聘内嵌浏览器分别记录结果，不用 Chromium 手机尺寸模拟替代。
6. 生产发布只接受已完成本地验收的版本；上线验证不承担新功能迭代调试。

## 当前执行结果和阻塞

### 2026-09-14 独立 PostgreSQL、Redis 和签名 HTTP 组合验收

新增 `scripts/local-pg-fixture.py`、`local-redis-fixture.py`、`test-local-postgres-contract.py`、`test-local-redis-contract.py`。使用 WSL 已有 PostgreSQL 16 二进制建立独立集群；Redis 及所需库通过 Ubuntu 包下载并解包到任务目录，未安装或重启系统默认 Redis 服务。每轮使用新的 UUID 数据目录、随机本机端口和临时密码，只绑定 127.0.0.1，不访问已有业务库；所有任务服务在 finally 中停止。

| 指标 | 结果 | 证据 |
|---|---|---|
| 真实 PostgreSQL 保存对账 | 六题不具备完成条件，八题具备；各重复同步三次，答案严格一致，追问仍只一条且归属 Q2 | `output/postgres-contract.log` |
| PostgreSQL + Redis + Aural→HR 签名 HTTP | 无签名拒绝、签名 begin、成功确认、失败入库、停用阻止执行、outbox 确认全部通过 | `output/postgres-redis-http-contract.log`；已断言使用真实 Redis，未降级内存 |
| Redis 跨进程防重放 | 8 个独立进程同时处理同一 nonce，仅一次接受，7 次拒绝；TTL 有效 | `output/redis-contract.log` |
| Redis 进程重建 | 新进程仍读到 nonce 和 token 黑名单 | 同上 |
| PostgreSQL 并发分发 | 4 个线程处理 20 条合成投递，每条只投递一次；20 条处理任务、20 条面试记录 | `output/postgres-concurrency-contract-fixed.log`，现版 HR 实际用例 |
| PostgreSQL 锁排他与释放 | 独立连接竞争时不能重复取得锁，释放后可以重新取得 | 同上；2/2 通过、0 跳过、0 失败 |
| 服务回收 | 各轮 report 确认 PostgreSQL/Redis 停止；另行检查已结束实例无活动 PostgreSQL、无 Redis pid 文件 | 每轮 `output/local-sandbox/*contract-*/result.json` |

首次并发测试启动因新增 pytest 汇总插件的 hook 参数名错误而失败（PluginValidationError），测试尚未运行；修正参数名为 report 后 2/2 通过。失败日志 `output/postgres-concurrency-contract.log` 保留。产品源码未因该测试缺陷改变。

准确范围：上述使用真实 HR 数据库/Redis、真实 Aural 控制模块/HR HTTP 路由及真实保存对账逻辑；Aural 保存回放仍是受控本地回放，供应商任务使用合成返回，不是 Aural Supabase/存储、完整 Next、八题真实模型或官网至报告完整 E2E。反复出现的六题/八题及六项协议指标不重复计为新的独立检查。

本轮未查到当前环境中名称明确为 TEST/LOCAL/STAGING/SANDBOX 的模型、语音、Supabase 或存储配置，未读取生产秘密来填充。剩余关键条件仍包括完整 Next 命令获准执行、独立 Aural 数据与存储、真实模型专用配置及整链验收。无需候选人操作；不得把上述后端层级升级为“全部完成”。没有 main 提交、推送或部署。

### 音频偶发失败定点复查（23:52 开始）

为排查最初 Q5 内容相关性失败，在原音频测试中新增每题包到达时刻、字节数、采集前后音频时钟和源时钟记录。没有改生产采集逻辑，没有放宽音频内容断言。使用合成测试信号，保存期望 Float32 和实际 PCM，不含人员声音。

- 本次八題音频检查 8/8 通过，命令退出 0；证据完整保留在 `output/audio-diagnostic-20260913-235223/`，包含 `run.log`、8 组 `.pcm`、`.expected.f32`、`.timing.json`。
- Q2 注入 5 秒主线程阻塞后，33 个数据包共 8.448 秒音频在约 3.270 秒内集中送达，内容检查通过。这是积压数据恢复送达的证据，不是实际模型端播放/识别时延验收。
- Q5 停止并重启采集后，原采集 AudioContext 为 closed，新增采集上下文 running；播放和录音上下文继续运行，总活动上下文保持 3。内容相关性 0.99858，本轮未复现原失败。
- 相同内容验证器另跑三个反例/正例用例，3/3 通过；丢掉或重复一个传输帧、静音及变速仍会判为不通过。
- 本轮未改音频产品源码，未改启动器绕过 Next 拒绝。该测试是实际 useVoice + 浏览器音频图 + 受控 WebSocket 接收端；视频轨来自测试画布，不与上一轮物理设备验收混淆。
- 原始偶发失败仍未闭环：最初失败没有对应原始 PCM，本轮有数据但未复现，不能从本轮通过反推最初无问题。不能仅靠继续重跑到绿色取消该项。

检查点：本轮测试已结束，浏览器及本轮独立音频模块测试服务已回收。完整 Next 仍处于已知自动审批拒绝状态；真实后端/模型完整面试和报告对账未完成，无 main、推送或部署动作。

### 本机真实硬件与实际录音逻辑（后续执行）

已发现本机状态正常的 FHD Camera、麦克风和扬声器，执行 `tests/real-device-local.mjs`，未使用假设备参数，未替换原生 getUserMedia 的返回。使用实际 `RecruitmentMediaAccess`、实际麦克风 Worklet 和实际 `useInterviewRecording`。

| 检查项 | 结果 | 证据及范围 |
|---|---|---|
| 无界面浏览器真实采集 | 失败，原生 NotSupportedError | `output/real-device-local-diagnostic.log`，无音视频数据产生 |
| 同版本有界面浏览器真实采集 | 通过，640×480，48kHz，41 个音频块 | `output/real-device-local-headed.log`；当前无界面运行时不能代替真实硬件验收 |
| 实际录音逻辑正常采集与截图 | 通过，3 秒录音、4 次摄像头截图 | `output/real-device-recording-retry-fixed.log`；真实硬件数据只存在浏览器内存，不保存、不外发 |
| 录音保存第一次失败及重试 | 通过；首次 500 被拒绝，第二次确认；两次录音均 56513 字节 | 同上；浏览器内模拟上传端，不代表真实存储及 HR 对账 |
| 结束资源回收 | 通过，原始及测试克隆轨道全部停止 | 浏览器关闭，未遗留本轮设备采集进程 |
| 完整 Next 服务原命令 | 再次在进程创建前被自动审批拒绝 | 仍为 blocked by policy，没有具体原因，未通过其他启动器或工具绕过 |

执行命令（明确打开本机设备）：PowerShell 设置 `AURAL_REAL_DEVICE_ACCEPTANCE=1`、`AURAL_REAL_DEVICE_HEADED=1` 后运行 `node tests/real-device-local.mjs`。脚本默认没有硬件 opt-in 时拒绝执行。每次结果存入带时间戳的 `output/real-device-local/` 子目录，原始画面/声音不写磁盘，上传由浏览器内存接收器拦截。

失败历史：第一次录音重试用例错误地按 `audio` 注入失败，但产品上传类型是 `recording`，导致未注入 500。保留 `output/real-device-recording-retry.log`，其早期 JSON 的 passed 字段只代表硬件检查，整个命令退出 1，不能计为通过。脚本已修正类型，并将最终 passed 改为所有断言条件的合并结果；修正后退出 0。产品代码未因此改变。

此结果证明本机真实设备及录音保存恢复行为，不证明 iPhone 猎聘、真实上传后端、八题语音模型或完整投递报告链路。以前音频 Q5 偶发失败及假摄像头失败，仍未获得现场根因证据，不能借本轮硬件通过关闭它们。用户的“全部结束后上线”条件仍未满足。

### 不使用云真机的本地方案继续执行

王总确认按本地隔离、浏览器故障模拟方案继续。本轮不接入云平台，iPhone 猎聘兼容性仍标为未验证，不将桌面模拟升级为真机通过。

| 新增指标 | 实测结果 | 边界 |
|---|---|---|
| E12 等待授权及已连接时反复后台/前台恢复信号 | 通过；一次设备申请、一次成功连接，轨道保持 live | 注入 visibility/focus/devicechange，未模拟操作系统挂起进程 |
| E13 浏览器缺少 Permissions 查询 API | 通过；拒绝后恢复权限并触发 focus，自动继续，无第二个开始按钮 | 受控 API 能力模拟 |
| E14 中转创建失败后网络恢复 | 通过；失败期间没有成功连接，online 后自动进入，设备申请仍为一次 | 注入 WebSocket 构造失败，不是物理断网或真实供应商故障 |
| 入口与资源竞态合跑 | 16/16 通过，无跳过 | 10 个组件浏览器用例及 6 个资源管理单元用例；不含完整 Next 服务 |
| 类型检查 | ratchet 通过，46/51 已知诊断，无新增 | 不是全仓零类型错误 |
| 手机首屏失败提示 | 截图确认提示在首屏，题目保留，无横向溢出 | Chromium 390×844，不等于实际 iOS |

证据：`output/entry-lifecycle-new.log`、`output/entry-network-new.log`、`output/entry-local-expanded.log`、`output/typecheck-expanded-entry.log`，以及 `output/entry-browser-chromium/relay-offline.png` 和恢复截图。

测试文件 SHA256：`afaec1e19099be4b121d4907e262c2fba4127b00d592345568e8adcdd6321439`。本轮仅补测试及记录，产品代码未改变，未反复重跑未受影响的全仓构建或后端测试充数。先前音频/摄像头失败历史仍保留。完整 Next 启动无解除证据，不更换工具或启动器绕过拒绝；本轮未盲目重复启动。独立后端全链路与真实采集仍未完成，不上线。

最新执行拦截及云真机接入复核见 [脱敏诊断与验收表](LOCAL_EXECUTION_BLOCK_DIAGNOSTIC_2026-09-13.md)。已实际打开云平台控制台并复测原 Next 命令；两项均未通过，未解除限制、未运行云真机。

### 无自备手机情况下的实际模拟与结论边界

王总说明没有测试手机/设备平台，要求代理自行解决，不再向其索要设备。已执行：

1. 安装 Linux Playwright WebKit 26.0 及其系统依赖，构建同一份组件供跨系统运行，没有启动被拒绝的 Next 服务。保持浏览器安全策略，没有关闭权限或 HTTPS 校验。
2. 以 iPhone 参数运行 WebKit：`output/webkit-linux-acceptance.log` 为 1 通过/6 失败，不计验收通过。进一步用不加载任何产品代码的独立能力页，在 headless WPE 与 GTK 两个模式检查，均发现 `MediaRecorder` 为 undefined；`MediaStream`、音频轨与视频轨可用。证据 `output/webkit-native-capabilities-confirm.log`。这证明当前模拟器有能力差异，不能把这项失败当作实际 iPhone 故障。
3. Chromium 加截图对应猎聘 iPhone UA、390×844 手机布局/触摸，正常及异常入口 7/7 通过，`output/liepin-useragent-entry.log`。它验证浏览器标识/布局路径与受控异常恢复，不代表猎聘 App 内嵌策略通过。
4. 只读回查 13:50–14:10 服务日志：语音服务该窗口没有日志，页面服务有两条 error 标记；没有足够客户端关联信息把它们与截图锁定。未打印候选人数据。仍不能断言是手机打开、拒绝授权或某一服务错误导致该截图。

WebKit 定点复核 `output/webkit-startup-diagnostic.log` 进一步区分了症状：一次开始就拿到两种 live 轨道并建立一条模拟中转连接，计时已经到 0:14；失败在缺失 MediaRecorder，以及虚拟页面的 AudioWorklet 模块导入。这与用户截图计时 0:00、尚未进入不同，不可把模拟器故障替换为现场根因。未补假 Recorder、未降低断言以制造通过。跨系统复用的组件通过 `AURAL_COMPONENT_PREBUILT_DIR` 加载 Windows 构建的相同代码，模拟页面不是完整 Next 服务。

目前能够确认的是：旧版权限等待分支可以停留在“需要几秒钟”，拒绝后错误又会消失；不是所有“手机打不开”都已被证明由这一分支导致。模拟器失败、注入故障和现场真实故障必须分开。

后续更贴近现场的方案是云真机 App Live，在真实 iOS 运行猎聘，访问隔离 HTTPS 链路。BrowserStack 官方确认支持真实 iOS 和 App Store 安装：https://www.browserstack.com/docs/app-live 。当前会话没有该平台账号/设备会话/使用权限，未自行购买或冒充已运行。Playwright 官方也说明其 WebKit 构建不等同于已发布 Safari：https://playwright.dev/docs/browsers 。本地模拟先继续用于定位可复现的软件问题，云真机条件未具备不能填“真机通过”。

- 当前线上只读版本核验：HR `6ac9c22dfd21f01a9ad226bc6361055c7ac309c0`，Aural `b478728f379c75c0f85f89d95d18dbee0c15c71e`。HR 原工作区 HEAD 为 `b3bc2b2`，并有未提交的 `test_hr_model_bridge_http.py`；该测试依赖当前 Aural 基线不存在的 `hr-model-control.ts`。首次 40 通过/1 失败保留在 `output/hr-backend-acceptance.log`，根因为混用了另一开发阶段的测试，不能据此向入口修复中掺入未来协议。
- 已从精确 HR 线上提交建立 detached 本地验收副本 `D:/GGGG/kiro/hr-entry-acceptance-20260913`。没有创建环境分支，没有修改原 WIP，没有推送或部署。
- 该副本的生命周期、实时状态同步、面试恢复、远程模型任务控制：**80/80 通过**，`output/hr-exact-release-acceptance.log`。真实 Flask/SQLAlchemy，独立 SQLite 内存库，dotenv 禁用，通知 record_only，Aural/Redis 目标显式指向本机未监听端口；不是实际 PostgreSQL/Supabase 全链路。
- 新增 `scripts/test-local-hr-bridge.py`，运行现版 Aural `runHrModelTask` → loopback HTTP → HR 实际签名路由 → SQLite 入库。**6 项通过**：无签名拒绝、签名 begin、成功确认、失败入库、停用阻止再次执行、outbox 确认。证据 `output/hr-current-protocol-bridge.log` 和 `output/local-sandbox/bridge-*/result.json`。应用环境凭据不继承，Python 连接限定 loopback，Node 仅调用固定本地 HR URL，不调用供应商。
- Redis 在该测试中不可达，使用进程内 nonce/黑名单降级；不把它算作真实队列/多进程防重放验收。6 项协议检查也不等于投递→八题→录音→报告全链路。
- 设备/依赖只读检查：未发现 Windows 已连接的 iPhone；当前工具无真机平台。WSL Ubuntu 有 PostgreSQL 16 的现有实例，未写入或复用；本次未发现可用 Docker/Supabase 命令或独立 Aural 数据服务。现有 Redis 不是本次建立的隔离实例，未复用。
- 完整 Next 服务此前被自动审批反复拒绝，尚无解除证据。没有换启动器/执行环境绕过它；不因用户要求继续而假报该项通过。
- 已向王总询问可供代理执行验收的测试 iPhone/设备平台接入位置，未要求候选人操作。目标真机缺失和本地服务执行拦截是完成剩余验收的外部前置条件。

检查点：上面 80 项后端测试与 6 项协议检查均已结束并回收测试进程；产品运行源码本轮未变，新增的仅是验收脚本/记录。下一步：解除完整 Next 启动拦截并接入目标真机，建立独立 Supabase/队列/存储和网络约束，再执行完整投递及模型音视频链路。当前仍为“本地验收未完成，禁止上线”。用户要求全部通过后才开始上线，条件尚未满足，不触发生产动作。

2026-09-13 三轮审查后本地执行记录：

| 必测项 | 当前结果 | 证据 |
|---|---|---|
| 隔离配置与目录逃逸 | 9/9 通过 | `output/local-isolation-final.log`；含每个服务误连生产、URL 绕过、目录 junction、默认通知/凭据模式 |
| 入口异常与资源生命周期 | 13/13 通过 | `output/local-three-pass-acceptance.log` 包含该 13 项和当时 8 项隔离检查共 21/21；新增第 9 项在独立最终日志，合计 22 个不同用例，不重复计数 |
| 完整 Next 页面 | 阻塞，不通过 | 本地启动被自动审批拒绝，不能借换命令绕过 |
| 独立 HR/Aural/数据库/worker/存储全链路 | 未完成，不通过 | 独立依赖、进程网络约束和全链路收据尚缺 |
| 真实模型及目标 iPhone 猎聘 | 未完成，不通过 | 独立额度配置及真机证据尚缺 |
| 首次音频/摄像头偶发失败根因 | 未关闭 | 历史回归后来通过，但没有根因证据，不可删掉失败 |
| 发布结论 | 本地验收未完成，禁止上线 | 不申请/执行 main 推送、生产部署或生产调试 |

此轮改变的是规则、方案和新增本地配置检查器；产品运行源码未改变，因此不把上一轮构建等重新运行后重复计为新增证据。以后产品源码改变必须按硬要求重跑受影响层。

- 本次 `node --import tsx --test --test-concurrency=1 tests/recruitment-media-access.test.ts tests/recruitment-entry-browser.test.ts`：13/13，无跳过；`output/local-acceptance-followup.log`。
- 上一轮 504 项常规回归、27 项浏览器回归、最终构建等详见 `INTERVIEW_ENTRY_REPAIR_2026-09-13.md`，不重复计数为新层级。
- 用户再次明确要求本地验收后，启动仅监听 127.0.0.1:3219、使用测试占位参数的 Next 服务，仍被自动审批拒绝；只返回 `blocked by policy`，没有具体原因。未绕过此拒绝。它不表示系统技术上只能在生产运行。
- 当前不具备真实 iPhone 猎聘的设备控制与验收证据。

## 持久测试站的规则边界

当前 HR `AGENTS.md`/`DEPLOYMENT_POLICY.md` 明确只允许一个已部署生产环境，本机检测与本地模式可以继续。上述方案优先本机实现，不新增已部署 HR 环境或长期环境分支。

如果后续选择常驻、可从手机访问的独立测试站，需要明确修订“只有一个已部署环境”的规则，并配置专用基础设施和真机 HTTPS 入口。不能把这个决定偷换成修改线上官网，或者绕过现有运行时校验。

# 面试入口修复与验收指标

基线：线上 Aural `b478728f379c75c0f85f89d95d18dbee0c15c71e`。
工作区：`D:/GGGG/kiro/aural-entry-fix-20260913`。
范围：候选人从须知点击开始到音视频连接、Q1 开场的入口；保留冻结合同。

| 编号 | 已发现问题 / 风险 | 必须通过的指标 | 状态 |
|---|---|---|---|
| E01 | 授权发生在组件挂载后，且音视频分次申请 | 唯一开始点击内直接申请音视频；无设备测试或第二开始按钮 | 已修复，Chromium 行为通过 |
| E02 | 授权 pending 导致 76 秒仍显示需要几秒钟 | 等待提示准确；不取消邀请；迟到授权自动继续 | 已修复，模拟 pending/迟到授权通过；无法替浏览器强制授予权限 |
| E03 | 拒绝授权后三次重试并清空错误 | 明确中文原因持续显示于手机首屏；不反复弹权限 | 已修复，390px 手机首屏及拒绝 6.5 秒后仍可见通过 |
| E04 | 恢复事件被 in-flight 锁阻挡 | 权限恢复自动继续；一次语音连接；旧请求迟到不泄漏设备 | 已修复，浏览器恢复及 6 项状态/竞态单测通过 |
| E05 | 权限探测流丢弃，后续重复申请麦克风 | 音视频流复用；结束/退出/迟到回调无遗留轨道 | 已修复，挂起退出、正常退出、迟到旧流释放通过 |
| E06 | 正常和迟到授权回归 | 摄像头、麦克风、计时、Q1 均可见；无新按钮 | Chromium 模拟媒体/中转通过；video 解码帧及计时推进断言已通过 |
| E07 | 断连重连、录音/保存受到影响 | 原有行为回归通过；不漏录、不提前完成、不新增类型/lint 错误 | web 504 项、组件 20 项通过；音频 8 段对照通过，见失败历史 |
| E08 | 证据覆盖不足 | 每项有行为证据；真实 iPhone 猎聘、生产 AI 开场单独记录 | 未关闭：真实设备和生产验收尚未进行 |
| E09 | 原生音频内容测试首轮 Q5 偶发失败 | 不降低原有音频完整性门槛；保存失败并比较基线 | 基线 8/8，修复版连续两轮各 8/8；首轮原因未证实，不标为已修复 |
| E10 | 构建后完整 Next 页面未验收 | 最终源码构建通过、完整路由入口通过 | 最终构建通过；完整页面未通过：本地 Next 服务启动被自动审批拒绝 |
| E11 | 摄像头专项初跑轨道结束、无图片 | 正常、启动瞬断、播放瞬断、轨道结束后均恢复并有截图 | 基线和修复版复核均 4/4；首轮原因未证实，保留失败历史 |

不得把模拟授权/模拟语音成功标为真实 iPhone 猎聘通过。不得以提示语改变代表底层浏览器权限已恢复。
生产部署及最终生产样本遵循仓库独立批准门禁，当前不计为已完成。

## 诊断结论及边界

线上入口成功返回不代表音视频已连接。该 iPhone 猎聘 UA 的页面和候选人读取返回 200，但对应时间段没有建立语音链路的证据。在线资源配合本地合成 API/媒体故障注入，复现了 pending 76 秒仍停留在原提示，以及拒绝授权后提示消失。源码确认 `getUserMedia` 等待发生在中转连接之前。

这足以证实入口存在缺陷，不能据此断言真实手机一定拒绝过权限，也不能断言最近发布新引入：相关关键等待逻辑在之前已存在。设备、内嵌浏览器权限状态不同，会触发以往成功路径未覆盖的分支。

## 实施

- 开始点击同步发起一次音视频申请，媒体控制器保留逻辑请求及流；采集、录像分别使用音轨/视频轨克隆。
- 等待阈值仅切换准确提示，不取消面试或要求重来。拒绝/不可用原因保持可见。
- 权限、设备、页面恢复信号触发恢复；确认已授权时可接续失效的原生请求，任一有效请求先成功均继续一次，迟到流停止。
- 卸载和终态释放资源，忽略迟到回调；预览 `play()` 未完成不再阻塞录像初始化。
- 摄像头保持启用，须知和唯一开始按钮保留，无设备测试或新增开始步骤。

## 证据与复跑

所有以下浏览器结果使用合成数据和模拟媒体/中转，没有生产面试写入。

- 原问题复现：`D:/GGGG/kiro/oprun-hr/output/startup-diagnostic-20260913/report.md`。
- `node --import tsx --test tests/recruitment-media-access.test.ts`：`output/media-access-tests.log`，6/6。
- `node --import tsx --test --test-concurrency=1 tests/recruitment-entry-browser.test.ts tests/functional-components.test.mjs`：末轮 `output/browser-final.log`，27/27，另 4 项跳过（3 项完整 Next 页面、1 项未开启的并发场景）。
- 手机截图/状态：`output/entry-browser-chromium/`。viewport 为真实 CSS 390×844，而非默认 980 缩放。
- `npm run test:web`：`output/web-tests-verified.log`，504/504。
- 最终 `npm run build`：`output/build-verified-final.log`，成功编译并生成 90/90 静态页面。本地占位构建，不是远程 main 的生产制品。
- `npm run typecheck:ratchet`、`npm run lint:ratchet`：`output/typecheck-final.log`（46/51 既有问题）、`output/lint-final.log`（21/21 既有问题），零新增；不等于原始 tsc/lint 零错误。
- 原生 AudioWorklet/实际音频内容回归：`output/audio-baseline.log`、`output/audio-candidate.log`、`output/audio-candidate-confirm.log` 各 8/8；波形保存在同名目录。
- `CAMERA_TEST_COUNT=4 node tests/recording-camera-browser.test.mjs`（PowerShell 用 `$env:CAMERA_TEST_COUNT='4'` 设置）：`output/camera-baseline.log` 与 `output/camera-confirm.log`，各 4/4。本地浏览器假摄像头，非真实 iPhone。

## 未关闭项与失败历史

- `output/media-verified.log` 保留首次 Q5 音频锚点失败（0.744，门槛未降低）。之后线上基线、修复版两轮完整通过，不足以证明首轮失败原因；生产音频稳定性未验收。
- `output/camera-final.log` 保留首次摄像头轨道结束/2 像素画面/0 图片失败。原代码基线和相同修复代码随后独立运行均 4/4；未降低断言，也未把复核成功描述为已查明首次失败原因。
- `output/build-final.log` 保留漏设本地 `SUPABASE_URL` 导致构建失败；补齐仅用于本地构建的占位参数重跑，没有连接或修改生产数据库。
- Windows WebKit 测试环境缺少原生 `MediaStreamTrack`，日志 `output/entry-webkit-probe.log`。不计为 iOS Safari/猎聘通过，也不据此认定产品失败。
- 完整 Next 本地服务器启动被自动审批拒绝，仅返回 `blocked by policy`，未提供具体原因。没有绕过该拒绝；组件行为测试不能冒充完整 Next 路由验收。
- 部署、真实 iPhone 猎聘及生产 AI 开场均未通过。依照 `DEPLOYMENT_POLICY.md`，当前修复授权不包含合并/推送 main、部署、服务重启；最终生产批次也需独立、限定数量的授权。

## 检查点

实际 checkout：`D:/GGGG/kiro/aural-entry-fix-20260913`，`codex/fix-interview-entry-20260913`，基于线上 b478728。未改原有 WIP，未提交、合并、推送、部署或重启。改动为入口页、VoiceInterface、两个原有媒体 hooks、新媒体控制器/hook、功能测试 harness 及新增回归。末轮浏览器、静态门槛、构建均已完成；无待回收的测试进程。改动清单和内容哈希见 `output/source-manifest.json`。下一步是解除完整页面测试环境阻塞、核验真实 iPhone 猎聘，再按独立授权执行 main/部署与限定生产验收。不能报告“线上已完全修复”。

# OpRun 招聘面试全链路 E2E

从简历投递到面试结束的候选人视角端到端测试，跑在 WSL 无头 Chromium 里，
直连唯一生产环境。它会写入一条脱敏测试申请，因此默认拒绝运行，不能作为本地发布门。

运行前必须在当前任务中分别获得生产 E2E、指定脱敏内容和指定岗位授权，并显式提供：

```bash
PRODUCTION_E2E_APPROVED=YES \
PRODUCTION_RESUME_APPROVED=YES \
HR_API_BASE=https://hr.yifx.vip \
RESUME_INDEX=7 \
PRODUCTION_RESUME_TEXT_SHA256=<获批脱敏文本的64位SHA-256> \
PRODUCTION_POSITION_ID=9 \
npm run test:e2e
```

缺少任一显式条件或简历实际内容指纹不匹配时必须失败退出。`npm run test:e2e` 只新增一条
获批申请并完整作答八题。只做用例发现可运行
`npm run test:e2e:list`，该命令不会投递简历。

## 跑法(WSL,Node 20)

```bash
# 首次:装依赖与浏览器(已装过可跳过)
cd /mnt/d/GGGG/kiro/aural-oss/tests/e2e
npm install --registry=https://registry.npmmirror.com
PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright npx playwright install chromium

# 每次生产真人模拟(必须使用上文全部批准变量，无默认简历或默认岗位)
npm run test:e2e

# 生产诊断套件(同一轮各 spec 只复用本轮唯一申请)
npm run test:e2e:diagnostic
```

“无岗投递”会额外新增第二条申请，默认跳过；只有另行批准并同时提供
`PRODUCTION_NEGATIVE_APPLY_APPROVED=YES`、`PRODUCTION_NEGATIVE_RESUME_INDEX` 和
`PRODUCTION_NEGATIVE_RESUME_TEXT_SHA256` 才会执行。

依赖的 WSL 系统库(libnss3/libasound2 等)已装过;若新机器报
`browserType.launch` 崩溃,用 root 执行 `npx playwright install-deps chromium`。

## 用例

| 文件 | 用例 | 断言要点 |
|---|---|---|
| 01-pipeline | 投递→就绪 ≤60s | 提速回归:分岗退回深思考模型会超时 |
| 01-pipeline | 题目质量扫描 | Q1+Q2 快速开放、最终恰好 8 道计分题；无"离职/空窗"前提；无占位岗位；Q1=计分自我介绍 |
| 02-flow | 面试须知页 | 唯一"开始面试"按钮;无设备测试;勾选前禁用 |
| 02-flow | 面试开始 | 标题/问候带真实岗位名 |
| 02-flow | 答题→下一题 | 聊天作答→AI 回应→中央大按钮→切第 2 题 |
| 02-flow | 提前结束 | 八题未完成时拒绝完成并留在当前题 |

截图证据落在 `screenshots/`，申请状态落在 `test-results/e2e-state.json`。每次命令产生
新的运行标识，只允许本轮不同 spec 复用本轮申请，不能复用历史候选人。

## 已知边界

- 走生产真实数据：每次全量跑会新增候选人（简历库已脱敏）；
  遗留候选人目前需人工在 HR 后台清理,暂无自动回收。
- Playwright 使用假媒体设备，只能验证浏览器确实请求了音视频和候选人流程；聊天作答与
  语音共用 relay 状态机，但不能证明真实麦克风、ASR、TTS和真人抢话体验。后者必须单独
  运行获批的真人语音验收，禁止把本套测试称为真人验收。
- `docx` 生成段落必须用 `TextRun` 实例,传 `{text}` 裸对象会产出
  空文本简历,HR 侧判 `blocked_input`(踩过,勿改回)。

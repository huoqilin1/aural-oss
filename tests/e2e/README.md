# OpRun 招聘面试全链路 E2E

从简历投递到面试结束的候选人视角端到端测试,跑在 WSL 无头 Chromium 里,
直连生产环境(`hr.yifx.vip` + `agitest.yifx.vip`)。

## 跑法(WSL,Node 20)

```bash
# 首次:装依赖与浏览器(已装过可跳过)
cd /mnt/d/GGGG/kiro/aural-oss/tests/e2e
npm install --registry=https://registry.npmmirror.com
PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright npx playwright install chromium

# 每次运行(默认用简历库索引 3)
npx playwright test

# 指定简历库条目/环境
RESUME_INDEX=5 npx playwright test
HR_API_BASE=https://hr.yifx.vip npx playwright test
```

依赖的 WSL 系统库(libnss3/libasound2 等)已装过;若新机器报
`browserType.launch` 崩溃,用 root 执行 `npx playwright install-deps chromium`。

## 用例

| 文件 | 用例 | 断言要点 |
|---|---|---|
| 01-pipeline | 投递→就绪 ≤60s | 提速回归:分岗退回深思考模型会超时 |
| 01-pipeline | 题目质量扫描 | ≥9 题;无"离职/空窗"前提;无"数君岗位"占位;开场=自我介绍 |
| 02-flow | 面试须知页 | 勾选前"开始面试"禁用 |
| 02-flow | 面试开始 | 标题/问候带真实岗位名 |
| 02-flow | 答题→下一题 | 聊天作答→AI 回应→中央大按钮→切第 2 题 |
| 02-flow | 结束面试 | 确认框可点→完成页 |

截图证据落在 `screenshots/`,申请状态落在 `test-results/e2e-state.json`
(30 分钟内的申请会被复用,避免重复投递)。

## 已知边界

- 走生产真实数据:每次全量跑会新增 1 名候选人(简历库已脱敏);
  遗留候选人目前需人工在 HR 后台清理,暂无自动回收。
- 语音通道不自动化(假麦克风是静音流);作答走聊天输入,与语音同经
  relay `text_input`。真人语音体验仍建议人工抽查。
- `docx` 生成段落必须用 `TextRun` 实例,传 `{text}` 裸对象会产出
  空文本简历,HR 侧判 `blocked_input`(踩过,勿改回)。

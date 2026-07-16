# Aural 开发与部署强制入口

每次开始工作，以及任何合并、推送、构建生产包、重启服务或部署前，必须重新读取 `DEPLOYMENT_POLICY.md`。

未经王总在当前任务中明确同意：

- 禁止合并或推送 `main`；
- 禁止部署、替换生产构建或重启 `aural.service`；
- 禁止设置任何批准环境变量绕过 hook。

生产部署前必须先执行 `.githooks/pre-deploy`。只有干净的 `main`、已同步到 `origin/main` 的明确提交可以部署。

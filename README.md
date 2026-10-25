# gmafx

Cloudflare Worker 单文件脚本 `_afxworker.js`。

## 2026-10-25 CPU 过载修复
- 中继改为惰性启动：直连在 300ms 窗口内成功就不再拨中继
- 所有拨号超时都会关闭 socket 并清除定时器
- DoH 解析加并发去重和 60 秒负缓存
- 目标为 CF IP 时跳过直连；首轮中继 3 路，兜底只补试未用过的中继
- 修复首包判定定时器与消息并发导致的重复建连
- DNS 数据报按 VLESS UDP 帧格式收发
- CIDR、UUID 字节预计算；readFull 真超时

## 测试
- 本地：`npm install && npm run dev`，另开终端 `npm test`
- GitHub Actions（`.github/workflows/test.yml`）：
  - 第一层 `local`：每次 push 用 wrangler dev 跑冒烟测试（订阅、Clash、404、隧道、错误 UUID、并发）
  - 第二层 `deploy-test`：部署到独立的 `gmafx-test` Worker 后对线上再测一遍；需在 Settings → Secrets and variables → Actions 添加 `CLOUDFLARE_API_TOKEN`（模板 "Edit Cloudflare Workers"）和 `CLOUDFLARE_ACCOUNT_ID`，未配置时自动跳过
- CPU 是否下降：Cloudflare 后台 → Workers → gmafx-test → Metrics → CPU time

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

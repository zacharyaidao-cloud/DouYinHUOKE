# 华贸获客（抖音获客软件）

一套 Windows 桌面获客工具：从抖音视频/关键词搜索采集评论区线索，用 DeepSeek 做「是/否」需求判断，再按固定名单执行关注与私信，并保留可复核的回执与人工核验记录。

## 技术栈
- Electron（桌面壳 + 内嵌账号浏览器）
- Node.js 本地后端（HTTP API，仅监听 127.0.0.1）
- Playwright（驱动系统 Chrome / Edge，每账号独立 profile）
- 本地 JSON 存储（原子写 + .bak）
- DeepSeek（AI 判断）、RSA 签名租约（独立授权服务）

## 目录
| 目录 | 说明 |
|---|---|
| `desktop/` | Electron 主进程、内嵌账号浏览器、preload |
| `dy-lead-app/` | 后端与网页工作台：server / engine / workflow / ai / lib |
| `douyin-lead-ext/` | 早期浏览器插件版本（参考） |
| `license-server/` | 授权服务（仅监听 loopback，由 HTTPS 反代终止） |
| `license-admin-web/` | 授权账户网页管理端 |
| `build-tools/` | 混淆构建、发布门禁、安装包脚本 |
| `使用文档/` | 字段字典与使用说明 |

## 构建
详见 `build-tools/build.ps1` 与 `build-tools/release-verify.js`（分层发布门禁：static / unit / artifact / smoke / installer）。

> 本仓库只包含源码与文档。客户数据、授权私钥、安装包、内置 Chromium 等均不纳入版本控制。

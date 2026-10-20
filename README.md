# 华贸获客（抖音获客软件）

一套 Windows 获客工具：关键词搜索抖音作品 → 采集视频 / 图文评论区线索 → 按评论时间筛选后用 DeepSeek 做「是 / 否」需求判断 → 单账号或多账号执行关注与私信，并保留可复核的回执与人工核验记录。

## 在新电脑上运行（源码方式）

### 1. 准备

| 需要 | 说明 |
|---|---|
| Windows 10/11 | 程序只支持 Windows |
| Node.js 20 或更高 | <https://nodejs.org/zh-cn>，安装时保持默认勾选 “Add to PATH” |
| Google Chrome 或 Microsoft Edge | 账号浏览器用系统里的 Chrome / Edge 打开 |
| Git（可选） | 也可以在 GitHub 页面点 “Code → Download ZIP” 下载 |
| 软件授权账号 | 登录界面使用原有的授权账号密码 |

### 2. 下载

```bash
git clone https://github.com/zacharyaidao-cloud/DouYinHUOKE.git
```

### 3. 安装依赖

双击根目录的 **`一键安装.bat`**。它会安装后端依赖（`playwright-core`、`ws`），并把本机的 `node.exe` 复制到 `dy-lead-app/`（桌面版需要）。

国内网络安装慢时，先执行：

```bash
npm config set registry https://registry.npmmirror.com
```

### 4. 启动

| 方式 | 操作 | 说明 |
|---|---|---|
| 网页版（推荐） | 双击 **`启动-网页版.bat`** | 自动打开 <http://127.0.0.1:17888>；黑色窗口不要关，关掉即停止服务。账号使用「外部浏览器」模式 |
| 桌面版 | 双击 **`启动-桌面版.bat`** | 首次运行下载 Electron 44.6.0（约 100MB）；支持「内嵌浏览器」账号模式 |

也可以用命令行：`npm run setup` / `npm start` / `npm run desktop`。

### 5. 数据位置

- 线索、作品、设置、账号浏览器资料、日志都在 **`dy-lead-app/data/`**（已被 `.gitignore` 排除，不会上传）
- 想换目录：在 `dy-lead-app/config.json` 写 `{"dataDir": "D:\\抖音获客数据"}`，或设置环境变量 `DY_LEAD_DATA_DIR`
- 从旧电脑迁移：关闭软件后，把旧电脑的整个 `data` 目录复制过来即可（账号登录状态在 `data/chrome-profiles/` 里）
- 日志：`dy-lead-app/data/logs/<账号ID>-<日期>.log`

## 目录结构

```
DouYinHUOKE/
├── 一键安装.bat / 启动-网页版.bat / 启动-桌面版.bat   新电脑运行入口
├── package.json                 根目录命令（setup / start / desktop / test）
├── dy-lead-app/                 ★ 核心：后端 + 网页工作台 + 全部业务逻辑
│   ├── server.js                本地 HTTP 接口（只监听 127.0.0.1:17888）
│   ├── engine.js                任务状态、浏览器启动、单作品评论采集 collectOne
│   ├── engine-search-tasks.js   ① 关键词搜索
│   ├── engine-collection-tasks.js ② 采集队列（视频 / 图文）
│   ├── engine-ai-tasks.js, ai.js ③ AI 需求判断
│   ├── engine-actions.js        ④ 单账号：主页 → 关注 → 私信
│   ├── engine-dm-distribution.js ⑤ 多账号私信分发（频繁冷却排队、上限当日停用）
│   ├── workflow.js              能否关注 / 私信的资格规则
│   ├── store.js                 本地 JSON 存储（带读取缓存）
│   ├── scheduler.js             节奏、停止、连续异常
│   ├── lib/                     页面内操作与协议解析（outreach-browser、collection-browser、error-levels 等）
│   ├── web/                     前端单页
│   └── tests/                   node:test 单元测试
├── desktop/                     Electron 桌面壳 + 内嵌账号浏览器
├── build-tools/                 打包与发布门禁（build.ps1、release-verify.js、verify-*.js）
├── license-server/              授权服务（服务器端，与日常使用无关）
├── license-admin-web/           授权账户网页管理端
├── 使用文档/
│   ├── 程序梳理与优化修复指南-2026-10-20.md   ★ 业务流程、代码地图、问题与修复记录
│   ├── 华贸获客-字段与采集流程说明-2.4.6.*    当前字段字典
│   ├── 设计方案/  版本修复说明/  手册/  历史字段说明/
└── archive/                     不再使用的旧代码（早期插件、一次性版本脚本），仅供查阅
```

## 开发与测试

```bash
npm run setup                  # 安装依赖
npm test                       # 运行 dy-lead-app/tests 下全部单元测试
# 私信页面定位的隔离浏览器测试（不访问真实抖音），用本机 Chrome：
set VERIFY_CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe
npm run verify:outreach
```

排查问题先看 `使用文档/程序梳理与优化修复指南-2026-10-20.md` 第 10 节「排查手册」。

## 打包

打包安装程序见 `build-tools/build.ps1` 与 `build-tools/release-verify.js`（分层发布门禁：static / unit / artifact / smoke / installer）。打包要求 `desktop/package.json` 的版本号有对应的 `使用文档/华贸获客-字段与采集流程说明-<版本>.html` 和 `desktop/使用说明.txt`，生成方式见 `build-tools/generate-field-guide.js`。

> 本仓库只包含源码与文档。客户数据、授权私钥、安装包、内置 Chromium 均不纳入版本控制。

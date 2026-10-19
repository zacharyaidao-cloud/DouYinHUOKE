# 授权管理网页

软件所有者通过 `https://huamao.xyz/dy-license/manage/` 登录，管理客户账户。客户继续使用独立客户端，网页管理代码、管理员密码、服务密钥和审计日志均不进入客户安装包。

网页支持查看账户及电脑绑定、开通账户、修改到期日期和备注、启用或停用、解绑电脑、重置密码、删除，以及查看最近 100 条管理审计记录。删除必须输入完整用户名确认。停用、修改、重置密码、解绑和删除会使客户原有在线授权租约失效；客户端会在下一次授权检查时同步。已签名的短期离线窗口按客户授权协议处理。

## 登录与使用

管理员账户默认是 `admin`，使用单独生成的新密码，记录在部署时下载的私人 `网页管理登录信息.txt` 中。该管理账户独立于客户授权账户。网页不需要手工填写服务密钥。日常操作可查看本目录的 `管理系统使用说明.txt`。

开通客户账户时填写账户名、至少 8 位密码、到期日期和备注，然后保存。已有账户可以在列表中管理。重置后的密码需要由软件所有者自行交给客户，系统不会发送消息，也不会在列表或审计中保存明文密码。

管理登录闲置 30 分钟自动过期，单次登录最多持续 12 小时。使用完点击退出。连续尝试错误密码会被限制，10 分钟后重试。

## 服务端部署

仅服务端运行 `server.js`，监听 `127.0.0.1:18766`，由 Nginx 和 Cloudflare HTTPS 转发该管理路径。上游授权服务固定访问 `127.0.0.1:18765` 的指定管理接口，网页请求不能选择上游地址或携带管理密钥。

初次部署执行 `node init-admin.js`，它生成全新随机密码和加盐 scrypt 哈希；已有管理员配置存在时拒绝覆盖。`admin-data` 目录权限为 `0700`，哈希、私人密码文件和审计文件为 `0600`。密码不会显示在命令行输出中。Linux 服务账户必须能够读写这个私有目录。

服务环境变量：

| 变量 | 用途 |
| --- | --- |
| `ADMIN_WEB_DATA_DIR` | 私有管理数据目录，默认本目录的 `admin-data` |
| `ADMIN_WEB_PORT` | 本机网页管理端口，默认 `18766` |
| `ADMIN_PUBLIC_ORIGIN` | 精确 HTTPS 来源，默认 `https://huamao.xyz` |
| `ADMIN_LICENSE_PORT` | 本机授权服务端口，默认 `18765` |
| `LICENSE_ADMIN_KEY` | 原授权服务的独立管理密钥，仅供服务器使用 |
| `ADMIN_MANAGEMENT_CONFIG` | 可选：包含管理密钥的受保护环境配置文件 |

Nginx 可以剥离 `/dy-license/manage/` 前缀后转发到本机服务，也可以保留该前缀。必须将客户端的 `X-Forwarded-For` 覆盖为可信客户端 IP，不应原样接受外部自报的地址；即使 IP 改变，同一管理用户名仍单独限速。

浏览器使用 `Secure; HttpOnly; SameSite=Strict` Cookie，路径限定为 `/dy-license/manage/`。所有管理写操作验证精确 HTTPS Origin 和 CSRF；登录也验证 Origin。网页使用外部脚本和样式、严格 CSP，静态服务仅允许指定网页资源，无法读取配置和私有文件。审计只记操作者、动作、目标账户、结果和上海时间，不记录密码、密钥或请求体；文件超过 5 MiB 后保留一个上一份日志。

## 接口约定与测试

所有接口位于管理路径下的 `api/`。`GET api/me` 返回登录状态及当前 CSRF；`POST api/login` 接收 `{username,password}`。登录后的写入请求携带 `X-CSRF-Token`。`GET api/users` 获取客户列表，`GET api/audit` 获取审计记录，`POST api/logout` 退出。

`POST api/users` 开通账户，接收 `{username,password,expiresAt,note}`。`POST api/users/:username/update` 接收 `{expiresAt?,enabled?,note?}`；`unbind` 接收空对象；`reset-password` 接收 `{newPassword}`；`delete` 接收 `{confirmation:完整用户名}`。用户名路径需 URL 编码。

执行 `node --test tests/server.test.js` 验证登录、会话、CSRF、限流、路径隔离、错误脱敏、管理操作、顺序写入和真实隔离 v4 授权服务的撤销行为。所有数据位于临时目录，不访问正式账户。

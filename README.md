# email2api

将多个 IMAP 邮箱同步到本地加密 SQLite 缓存，并通过 Bearer Token API 和紧凑管理页面统一管理。

## 功能

- 多 IMAP 账号管理、连接测试、自定义同步文件夹、IDLE 实时同步、共享轮询和手动同步
- 全部、未读、垃圾箱邮件列表及安全正文查看
- 单封已读/未读和当前账号缓存邮件全部已读
- QQ、Gmail、iCloud、Outlook、QQ 企业邮箱、163 邮箱预设
- 使用 Nodemailer 和 SMTP 从主邮箱或别名发送富文本邮件及附件
- AES-256-GCM 加密邮箱凭据及邮件内容
- 附件按需从 IMAP 流式下载，不保存附件内容

## Docker 部署

直接使用 GHCR 发布的镜像：

```bash
docker pull ghcr.io/lizhian/email2api:latest
docker volume create email2api-data
docker run -d \
  --name email2api \
  --restart unless-stopped \
  -p 3000:3000 \
  -v email2api-data:/data \
  -e EMAIL2API_TOKEN='replace-with-at-least-32-private-characters' \
  ghcr.io/lizhian/email2api:latest
```

首次发布后，镜像的可见性由 GitHub Packages 设置控制。匿名拉取需要在仓库的 Package settings 中将包设为 `Public`。

也可以从本地源码构建：

```bash
cp .env.example .env
# 将 .env 中的 EMAIL2API_TOKEN 替换为私密随机值
docker compose up -d --build
```

打开 `http://localhost:3000`，输入与环境变量一致的 Token。Token 必须至少 32 个字符，并且已有数据库不能直接更换 Token。

数据存储在 `email2api-data` Docker volume。生产环境应在 HTTPS 反向代理后运行，避免 Bearer Token 经明文网络传输。

### 镜像标签

- `latest`：`main` 分支的最新构建。
- `sha-<短提交哈希>`：每次发布对应的不可变提交版本。
- `1.2.3`、`1.2`、`1`：稳定标签 `v1.2.3` 对应的完整、次版本和主版本别名。
- `1.2.3-rc.1`：预发布版本，只发布完整预发布标签和 `sha-*`，不会覆盖稳定版本别名。

## 本地开发

要求 Node.js 22 或更高版本。

```bash
npm install
npm run build -w @email2api/shared
EMAIL2API_TOKEN='replace-with-at-least-32-private-characters' \
EMAIL2API_DATA_DIR="$PWD/data" \
npm run dev
```

管理端开发服务器为 `http://localhost:5173`，API 为 `http://localhost:3000`。

```bash
npm run typecheck
npm test
npm run build
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `EMAIL2API_TOKEN` | 无 | 必填，至少 32 个字符，同时用于认证和密钥派生 |
| `EMAIL2API_DATA_DIR` | `/data` | SQLite 数据目录 |
| `PORT` | `3000` | HTTP 监听端口 |
| `HOST` | `0.0.0.0` | HTTP 监听地址 |
| `SYNC_INTERVAL_SECONDS` | `10` | 新数据库的无 IDLE 轮询初始值，范围 5–3600 秒；初始化后由系统设置管理 |
| `LOG_LEVEL` | `info` | Fastify 日志等级 |

## HTTP API

面向第三方项目集成的完整入参、出参、错误码、分页和 SSE 契约见 [HTTP API 接口说明](docs/API.md)。

所有 `/api/v1` 请求都需要认证：

```bash
curl -H "Authorization: Bearer $EMAIL2API_TOKEN" \
  http://localhost:3000/api/v1/accounts
```

主要接口：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `POST` | `/api/v1/auth/verify` | 验证 Token |
| `GET/POST` | `/api/v1/accounts` | 查询或新增账号 |
| `PUT` | `/api/v1/accounts/order` | 更新账号显示顺序 |
| `PATCH/DELETE` | `/api/v1/accounts/:id` | 更新或删除账号 |
| `POST` | `/api/v1/accounts/:id/test` | 测试 IMAP 连接 |
| `POST` | `/api/v1/accounts/:id/smtp/test` | 测试 SMTP 连接 |
| `POST` | `/api/v1/accounts/:id/sync` | 触发同步 |
| `GET` | `/api/v1/accounts/:id/mailboxes` | 查询可同步文件夹 |
| `PUT` | `/api/v1/accounts/:id/sync-folders` | 配置自定义同步文件夹及模式 |
| `GET` | `/api/v1/messages` | 查询邮件列表 |
| `GET` | `/api/v1/messages/:id` | 查询邮件详情 |
| `POST` | `/api/v1/messages/send` | 通过 SMTP 发送邮件和附件 |
| `GET` | `/api/v1/messages/:id/attachments/:attachmentId` | 按需下载附件 |
| `PATCH` | `/api/v1/messages/:id/read` | 标记已读或未读 |
| `POST` | `/api/v1/accounts/:id/messages/read-all` | 当前账号缓存全部已读 |
| `GET/PATCH` | `/api/v1/settings` | 查询或修改缓存、分页、轮询、附件下载及远程图片策略 |
| `GET` | `/api/v1/events` | 订阅邮件缓存和账号状态 SSE 事件 |

邮件列表支持 `accountId`、`view=all|unread|junk`、可重复的 `filter=verification_code|attachment|forwarded`、`after`、`before`、`cursor` 和 `limit`。时间参数使用带时区的 ISO 8601 格式，`limit` 默认 100、最大 100；管理端使用系统设置中的分页大小。

SSE 使用相同的 Bearer Token，不接受 URL Token。连接建立后会先发送 `ready`，客户端收到 `messages.changed` 后可重新查询邮件列表：

```bash
curl -N -H "Authorization: Bearer $EMAIL2API_TOKEN" \
  http://localhost:3000/api/v1/events
```

## 邮箱授权说明

Gmail、iCloud、QQ、163 等服务通常要求先开启 IMAP/SMTP，并使用应用专用密码或授权码。当前版本使用密码式 IMAP/SMTP 登录，不支持 OAuth；SMTP 始终复用账号主邮箱和现有授权码。QQ 企业邮箱或其他自定义域名可以在账号表单中选择服务商预设，或展开高级设置填写 IMAP 和 SMTP 主机。

## 安全边界

- Token 不写入数据库；浏览器仅在当前标签会话中保存 Token。
- 邮箱地址、服务器配置、凭据、主题、通信地址、正文、附件名和错误详情均加密存储。
- 时间、UID、文件夹类型、已读状态等查询索引保持明文；真实 IMAP 文件夹路径加密存储，仅保留不可逆索引。
- 邮件 HTML 会保留常见排版和内联样式，移除脚本、表单、事件属性及可执行内容，并在不允许脚本、弹窗和顶层导航的受限 iframe 中展示。远程图片默认阻止，用户可为当前邮件单独加载；安全且受大小限制的 CID 内嵌图片会本地化显示。正文链接由父页面拦截，确认目标地址后才在新标签打开。
- 除受限的 CID 正文图片外，附件内容不写入 SQLite 或本地文件系统；下载时使用独立 IMAP 连接按 MIME part 流式读取，并受全局并发和单附件大小设置限制。
- 发信附件仅在请求期间写入随机临时目录，SMTP 操作结束后立即清理；系统不保存草稿、发信历史或“已发送”副本。

## License

[MIT](LICENSE)

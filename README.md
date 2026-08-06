# imap2api

将多个 IMAP 邮箱同步到本地加密 SQLite 缓存，并通过 Bearer Token API 和紧凑管理页面统一管理。

## 功能

- 多 IMAP 账号管理、连接测试、状态显示、后台轮询和手动同步
- 全部、未读、垃圾箱邮件列表及安全正文查看
- 单封已读/未读和当前账号缓存邮件全部已读
- QQ、Gmail、iCloud、Outlook、QQ 企业邮箱、163 邮箱预设
- AES-256-GCM 加密邮箱凭据及邮件内容
- Docker 单容器部署，不保存或提供附件内容

## Docker 部署

直接使用 GHCR 发布的镜像：

```bash
docker pull ghcr.io/lizhian/imap2api:latest
docker volume create imap2api-data
docker run -d \
  --name imap2api \
  --restart unless-stopped \
  -p 3000:3000 \
  -v imap2api-data:/data \
  -e IMAP2API_TOKEN='replace-with-at-least-32-private-characters' \
  ghcr.io/lizhian/imap2api:latest
```

首次发布后，镜像的可见性由 GitHub Packages 设置控制。匿名拉取需要在仓库的 Package settings 中将包设为 `Public`。

也可以从本地源码构建：

```bash
cp .env.example .env
# 将 .env 中的 IMAP2API_TOKEN 替换为私密随机值
docker compose up -d --build
```

打开 `http://localhost:3000`，输入与环境变量一致的 Token。Token 必须至少 32 个字符，并且已有数据库不能直接更换 Token。

数据存储在 `imap2api-data` Docker volume。生产环境应在 HTTPS 反向代理后运行，避免 Bearer Token 经明文网络传输。

### 镜像标签

- `latest`：`main` 分支的最新构建。
- `sha-<短提交哈希>`：每次发布对应的不可变提交版本。
- `1.2.3`、`1.2`、`1`：稳定标签 `v1.2.3` 对应的完整、次版本和主版本别名。
- `1.2.3-rc.1`：预发布版本，只发布完整预发布标签和 `sha-*`，不会覆盖稳定版本别名。

## 本地开发

要求 Node.js 22 或更高版本。

```bash
npm install
npm run build -w @imap2api/shared
IMAP2API_TOKEN='replace-with-at-least-32-private-characters' \
IMAP2API_DATA_DIR="$PWD/data" \
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
| `IMAP2API_TOKEN` | 无 | 必填，至少 32 个字符，同时用于认证和密钥派生 |
| `IMAP2API_DATA_DIR` | `/data` | SQLite 数据目录 |
| `PORT` | `3000` | HTTP 监听端口 |
| `HOST` | `0.0.0.0` | HTTP 监听地址 |
| `SYNC_INTERVAL_SECONDS` | `300` | 后台同步间隔，最小 30 秒 |
| `LOG_LEVEL` | `info` | Fastify 日志等级 |

## HTTP API

所有 `/api/v1` 请求都需要认证：

```bash
curl -H "Authorization: Bearer $IMAP2API_TOKEN" \
  http://localhost:3000/api/v1/accounts
```

主要接口：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `POST` | `/api/v1/auth/verify` | 验证 Token |
| `GET/POST` | `/api/v1/accounts` | 查询或新增账号 |
| `PATCH/DELETE` | `/api/v1/accounts/:id` | 更新或删除账号 |
| `POST` | `/api/v1/accounts/:id/test` | 测试 IMAP 连接 |
| `POST` | `/api/v1/accounts/:id/sync` | 触发同步 |
| `GET` | `/api/v1/messages` | 查询邮件列表 |
| `GET` | `/api/v1/messages/:id` | 查询邮件详情 |
| `PATCH` | `/api/v1/messages/:id/read` | 标记已读或未读 |
| `POST` | `/api/v1/accounts/:id/messages/read-all` | 当前账号缓存全部已读 |
| `GET/PATCH` | `/api/v1/settings` | 查询或修改缓存上限 |

邮件列表支持 `accountId`、`view=all|unread|junk`、`after`、`before`、`cursor` 和 `limit`。时间参数使用带时区的 ISO 8601 格式，`limit` 默认 50、最大 100。

## 邮箱授权说明

Gmail、iCloud、QQ、163 等服务通常要求先开启 IMAP，并使用应用专用密码或授权码。当前版本使用密码式 IMAP 登录，不支持 OAuth。QQ 企业邮箱或其他自定义域名可以在账号表单中选择服务商预设，或展开高级设置填写 IMAP 主机。

## 安全边界

- Token 不写入数据库；浏览器仅在当前标签会话中保存 Token。
- 邮箱地址、服务器配置、凭据、主题、通信地址、正文、附件名和错误详情均加密存储。
- 时间、UID、文件夹、已读状态等查询索引保持明文。
- 邮件 HTML 会移除脚本、表单、事件属性和远程资源，并在受限 iframe 中展示。
- 附件不下载到 SQLite，不提供附件管理或下载接口。

## License

[MIT](LICENSE)

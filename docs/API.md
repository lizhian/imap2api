# imap2api HTTP API 接口说明

本文档面向需要把 imap2api 邮箱能力集成到其他项目的开发者，描述当前 `v1` 接口的认证方式、入参、出参、错误和 SSE 事件格式。

## 1. 接入信息

- API 基础地址：`http(s)://<host>:<port>/api/v1`
- 默认本地地址：`http://localhost:3000/api/v1`
- 数据格式：除 SSE 和 `204 No Content` 外，均为 JSON
- 字符编码：UTF-8
- 时间格式：带时区的 ISO 8601 字符串，例如 `2026-08-07T10:30:00.000Z`
- 资源 ID：UUID 字符串

生产环境必须通过 HTTPS 调用，避免 Bearer Token 和邮件内容经明文网络传输。

### 1.1 认证

除 `GET /healthz` 外，所有接口都必须携带服务端环境变量 `IMAP2API_TOKEN` 对应的 Bearer Token：

```http
Authorization: Bearer <IMAP2API_TOKEN>
```

JSON 请求还应携带：

```http
Content-Type: application/json
```

Token 缺失或错误时返回：

```http
HTTP/1.1 401 Unauthorized
Content-Type: application/json

{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Bearer Token 无效或缺失"
  }
}
```

### 1.2 快速验证

```bash
export IMAP2API_BASE_URL='http://localhost:3000/api/v1'
export IMAP2API_TOKEN='replace-with-your-token'

curl -X POST \
  -H "Authorization: Bearer $IMAP2API_TOKEN" \
  "$IMAP2API_BASE_URL/auth/verify"
```

成功响应：

```json
{
  "ok": true
}
```

## 2. 公共数据类型

### 2.1 枚举

| 类型 | 可选值 | 说明 |
| --- | --- | --- |
| `ProviderId` | `auto`, `qq`, `gmail`, `icloud`, `outlook`, `qq-enterprise`, `163`, `custom` | 邮箱服务商；`auto` 仅用于入参自动识别 |
| `ConnectionStatus` | `pending`, `connecting`, `connected`, `warning`, `error` | 账号连接状态 |
| `SyncMode` | `idle`, `polling` | 实时 IDLE 或定时轮询；尚未建立会话时为 `null` |
| `MessageView` | `all`, `unread`, `junk` | 邮件列表视图 |
| `FolderKind` | `inbox`, `junk` | 收件箱或垃圾箱 |
| `MessageLabel` | `forwarded`, `verification_code`, `unsubscribe` | 转发邮件、验证码邮件、可退订邮件 |

连接状态含义：

| 状态 | 含义 |
| --- | --- |
| `pending` | 账号刚创建或更新，等待连接 |
| `connecting` | 正在连接或初始化邮箱文件夹 |
| `connected` | 收件箱和垃圾箱均正常工作 |
| `warning` | 收件箱可用，但垃圾箱缺失或连接失败 |
| `error` | 收件箱连接或同步失败 |

### 2.2 `Address`

| 字段 | 类型 | 必有 | 说明 |
| --- | --- | --- | --- |
| `name` | `string` | 否 | 发件人或收件人的显示名称 |
| `address` | `string` | 是 | 邮箱地址 |

示例：

```json
{
  "name": "Example Sender",
  "address": "sender@example.com"
}
```

### 2.3 `Account`

账号出参不会返回密码或授权码。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `string(UUID)` | 账号 ID |
| `email` | `string` | 主邮箱地址，服务端会转为小写 |
| `aliases` | `string[]` | 别名邮箱地址，服务端会去除首尾空格并转为小写 |
| `provider` | `ProviderId` | 已解析的服务商；自动识别后不会返回 `auto` |
| `imap.provider` | `ProviderId` | 与顶层 `provider` 相同；集成时以顶层字段为主 |
| `imap.host` | `string` | 实际使用的 IMAP 主机 |
| `imap.port` | `integer` | 实际使用的 IMAP 端口 |
| `imap.secure` | `boolean` | 是否使用 TLS |
| `hasCredential` | `true` | 表示服务端已保存凭据，不代表返回了凭据 |
| `status` | `ConnectionStatus` | 当前连接状态 |
| `syncMode` | `SyncMode \| null` | 当前同步模式 |
| `lastSyncedAt` | `string \| null` | 最近一次成功同步时间 |
| `lastError` | `string \| null` | 最近连接错误摘要 |
| `createdAt` | `string` | 创建时间 |
| `updatedAt` | `string` | 更新时间 |

### 2.4 `MessageSummary`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `string(UUID)` | 本地邮件 ID；后续详情和已读操作使用此 ID |
| `accountId` | `string(UUID)` | 所属账号 ID |
| `accountEmail` | `string` | 所属账号邮箱 |
| `subject` | `string` | 主题 |
| `from` | `Address[]` | 发件人列表 |
| `preview` | `string` | 正文摘要 |
| `displayTime` | `string` | 邮件展示时间 |
| `folder` | `FolderKind` | 所属文件夹类型 |
| `read` | `boolean` | 是否已读 |
| `hasAttachments` | `boolean` | 是否包含附件 |
| `labels` | `MessageLabel[]` | 自动识别标签 |

### 2.5 `MessageDetail`

`MessageDetail` 包含 `MessageSummary` 的全部字段，并增加：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `to` | `Address[]` | 收件人列表 |
| `cc` | `Address[]` | 抄送人列表 |
| `attachments` | `string[]` | 附件文件名；服务不提供附件内容或下载接口 |
| `text` | `string` | 纯文本正文 |
| `html` | `string \| null` | 经服务端净化的 HTML 正文 |
| `verificationCode` | `string \| null` | 自动提取的验证码 |
| `unsubscribeUrl` | `string \| null` | 自动识别的退订链接 |

## 3. 接口总览

| 方法 | 路径 | 认证 | 成功状态码 | 作用 |
| --- | --- | --- | --- | --- |
| `GET` | `/healthz` | 否 | `200` | 健康检查，路径不含 `/api/v1` |
| `POST` | `/auth/verify` | 是 | `200` | 验证 Token |
| `GET` | `/accounts` | 是 | `200` | 查询账号列表 |
| `POST` | `/accounts` | 是 | `201` | 新增账号 |
| `PATCH` | `/accounts/:id` | 是 | `200` | 更新账号 |
| `DELETE` | `/accounts/:id` | 是 | `204` | 删除账号及其本地缓存 |
| `POST` | `/accounts/:id/test` | 是 | `200` | 测试 IMAP 连接 |
| `POST` | `/accounts/:id/sync` | 是 | `202` | 触发同步 |
| `GET` | `/messages` | 是 | `200` | 分页查询邮件摘要 |
| `GET` | `/messages/:id` | 是 | `200` | 查询邮件详情 |
| `PATCH` | `/messages/:id/read` | 是 | `200` | 标记单封邮件已读或未读 |
| `POST` | `/accounts/:id/messages/read-all` | 是 | `200` / `207` | 标记账号内缓存邮件全部已读 |
| `GET` | `/settings` | 是 | `200` | 查询系统设置 |
| `PATCH` | `/settings` | 是 | `200` | 修改系统设置 |
| `GET` | `/events` | 是 | `200` 持续连接 | 订阅 SSE 事件 |

以下业务路径均相对于 `/api/v1`。

## 4. 健康与认证

### 4.1 健康检查

```http
GET /healthz
```

入参：无。该路径不需要认证，也不带 `/api/v1` 前缀。

`200 OK`：

```json
{
  "status": "ok"
}
```

该接口只表示 HTTP 服务可响应，不代表所有邮箱账号均已连接。

### 4.2 验证 Token

```http
POST /api/v1/auth/verify
```

入参：无请求体。

`200 OK`：

```json
{
  "ok": true
}
```

## 5. 账号接口

### 5.1 查询账号列表

```http
GET /api/v1/accounts
```

入参：无。

`200 OK`：返回 `Account[]`，按创建时间升序排列。

```json
[
  {
    "id": "5f3deca8-7aa3-489a-bcf5-03ca02fb7474",
    "email": "user@gmail.com",
    "aliases": ["alias@example.com"],
    "provider": "gmail",
    "imap": {
      "provider": "gmail",
      "host": "imap.gmail.com",
      "port": 993,
      "secure": true
    },
    "hasCredential": true,
    "status": "connected",
    "syncMode": "idle",
    "lastSyncedAt": "2026-08-07T10:30:00.000Z",
    "lastError": null,
    "createdAt": "2026-08-07T10:00:00.000Z",
    "updatedAt": "2026-08-07T10:30:00.000Z"
  }
]
```

### 5.2 新增账号

```http
POST /api/v1/accounts
```

请求体：

| 字段 | 类型 | 必填 | 约束与说明 |
| --- | --- | --- | --- |
| `email` | `string` | 是 | 合法邮箱，最长 320 字符 |
| `password` | `string` | 是 | IMAP 密码、应用专用密码或授权码，长度 1–4096 |
| `aliases` | `string[]` | 否 | 最多 50 个合法邮箱；不能与主邮箱相同或重复 |
| `imap` | `object` | 否 | IMAP 服务商或连接配置；省略时自动识别 |
| `imap.provider` | `ProviderId` | 否 | 默认 `auto` |
| `imap.host` | `string` | 否 | 最长 255 字符；`custom` 或无法自动识别时必须可解析出主机 |
| `imap.port` | `integer` | 否 | 1–65535，默认使用预设值或 `993` |
| `imap.secure` | `boolean` | 否 | 默认使用预设值或 `true` |

已内置 `qq`、`gmail`、`icloud`、`outlook`、`qq-enterprise`、`163` 的 IMAP 预设。Gmail、iCloud、QQ、163 等邮箱通常需要应用专用密码或授权码；当前接口不支持 OAuth 登录。

自动识别示例：

```json
{
  "email": "user@gmail.com",
  "password": "application-specific-password",
  "aliases": ["alias@example.com"]
}
```

自定义 IMAP 示例：

```json
{
  "email": "user@example.com",
  "password": "imap-password",
  "imap": {
    "provider": "custom",
    "host": "imap.example.com",
    "port": 993,
    "secure": true
  }
}
```

`201 Created`：返回新建的 `Account`。初始 `status` 通常为 `pending`，连接由后台异步建立。

可能的业务错误：

- `400 VALIDATION_ERROR`：字段格式错误、别名冲突或无法解析 IMAP 主机。
- `409 ACCOUNT_EXISTS`：主邮箱账号已存在。

### 5.3 更新账号

```http
PATCH /api/v1/accounts/:id
```

路径参数：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `string(UUID)` | 账号 ID |

请求体可使用新增账号的任意字段，但至少提供一个字段；所有字段均为可选。

```json
{
  "password": "new-application-password",
  "aliases": ["ops@example.com"]
}
```

`200 OK`：返回更新后的 `Account`。更新会重置连接状态并重启该账号的同步会话；修改邮箱或别名还会重新分类已缓存邮件。

可能的业务错误：

- `400 VALIDATION_ERROR`
- `404 ACCOUNT_NOT_FOUND`
- `409 ACCOUNT_EXISTS`

### 5.4 删除账号

```http
DELETE /api/v1/accounts/:id
```

入参：路径参数 `id` 为账号 ID，无请求体。

`204 No Content`：成功，无响应体。操作会停止该账号的同步会话，并删除账号及其本地邮件缓存；不会删除远端邮箱中的邮件。

可能的业务错误：`404 ACCOUNT_NOT_FOUND`。

### 5.5 测试 IMAP 连接

```http
POST /api/v1/accounts/:id/test
```

入参：路径参数 `id` 为账号 ID，无请求体。

`200 OK`：

```json
{
  "ok": true
}
```

可能的业务错误：

- `404 ACCOUNT_NOT_FOUND`
- `502 IMAP_CONNECTION_FAILED`

### 5.6 触发同步

```http
POST /api/v1/accounts/:id/sync
```

入参：路径参数 `id` 为账号 ID，无请求体。

`202 Accepted`：

```json
{
  "status": "started"
}
```

`status` 可为：

- `started`：已接受本次同步触发。
- `running`：该账号已有同步任务运行，本次通知会合并进入现有调度，不代表启动了并行任务。

接口仅表示触发请求已接受，不代表同步已经完成。调用方应通过 SSE 的 `account.changed`、`messages.changed` 事件，或重新查询账号状态和邮件列表来获得最终结果。

可能的业务错误：`404 ACCOUNT_NOT_FOUND`。

## 6. 邮件接口

### 6.1 查询邮件列表

```http
GET /api/v1/messages
```

Query 参数：

| 参数 | 类型 | 必填 | 默认值 | 约束与语义 |
| --- | --- | --- | --- | --- |
| `accountId` | `string(UUID)` | 否 | 全部账号 | 只返回指定账号的邮件 |
| `view` | `MessageView` | 否 | `all` | `all` 包含收件箱和垃圾箱；`unread` 包含所有文件夹中的未读邮件；`junk` 只含垃圾箱邮件 |
| `after` | `string(datetime)` | 否 | 无 | `displayTime >= after` |
| `before` | `string(datetime)` | 否 | 无 | `displayTime < before` |
| `cursor` | `string` | 否 | 无 | 上一页返回的 `nextCursor`，最长 1000 字符；调用方不得解析或修改 |
| `limit` | `integer` | 否 | `50` | 1–100 |

`after` 和 `before` 必须为带时区的 ISO 8601 时间。结果按 `displayTime` 降序排列；时间相同时按邮件 ID 降序排列。

请求示例：

```http
GET /api/v1/messages?accountId=5f3deca8-7aa3-489a-bcf5-03ca02fb7474&view=unread&after=2026-08-01T00%3A00%3A00.000Z&limit=20
```

`200 OK`：

```json
{
  "items": [
    {
      "id": "f3380887-4238-439b-9636-b166ec51e270",
      "accountId": "5f3deca8-7aa3-489a-bcf5-03ca02fb7474",
      "accountEmail": "user@gmail.com",
      "subject": "Your verification code",
      "from": [
        {
          "name": "Example Service",
          "address": "no-reply@example.com"
        }
      ],
      "preview": "Use 123456 to complete verification...",
      "displayTime": "2026-08-07T10:25:00.000Z",
      "folder": "inbox",
      "read": false,
      "hasAttachments": false,
      "labels": ["verification_code"]
    }
  ],
  "nextCursor": "WyIyMDI2LTA4LTA3VDEwOjI1OjAwLjAwMFoiLCJmMzM4MDg4Ny00MjM4LTQzOWItOTYzNi1iMTY2ZWM1MWUyNzAiXQ"
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `items` | `MessageSummary[]` | 当前页邮件摘要 |
| `nextCursor` | `string \| null` | 下一页游标；为 `null` 时没有下一页 |

分页时应保留首个请求的 `accountId`、`view`、`after`、`before` 和 `limit`，仅追加或替换 `cursor`。游标依赖当前排序边界，缓存变化后可能出现正常的跨页漂移；对一致性敏感的调用方应在收到 SSE 变更事件后从第一页重新查询。

可能的业务错误：`400 VALIDATION_ERROR`，包括无效时间、枚举、范围或分页游标。

### 6.2 查询邮件详情

```http
GET /api/v1/messages/:id
```

入参：路径参数 `id` 为本地邮件 ID。

`200 OK`：返回 `MessageDetail`。

```json
{
  "id": "f3380887-4238-439b-9636-b166ec51e270",
  "accountId": "5f3deca8-7aa3-489a-bcf5-03ca02fb7474",
  "accountEmail": "user@gmail.com",
  "subject": "Your verification code",
  "from": [
    {
      "name": "Example Service",
      "address": "no-reply@example.com"
    }
  ],
  "preview": "Use 123456 to complete verification...",
  "displayTime": "2026-08-07T10:25:00.000Z",
  "folder": "inbox",
  "read": false,
  "hasAttachments": true,
  "labels": ["verification_code"],
  "to": [
    {
      "address": "user@gmail.com"
    }
  ],
  "cc": [],
  "attachments": ["invoice.pdf"],
  "text": "Use 123456 to complete verification.",
  "html": "<p>Use <strong>123456</strong> to complete verification.</p>",
  "verificationCode": "123456",
  "unsubscribeUrl": null
}
```

可能的业务错误：`404 MESSAGE_NOT_FOUND`。

安全注意：虽然 `html` 已由服务端净化，集成方仍应使用隔离且禁止脚本、弹窗和顶层导航的 sandbox iframe 展示，不能直接注入应用 DOM。远程图片和外部链接也应由宿主应用显式控制。

### 6.3 标记单封邮件已读或未读

```http
PATCH /api/v1/messages/:id/read
```

路径参数 `id` 为本地邮件 ID。

请求体：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `read` | `boolean` | 是 | `true` 标记已读，`false` 标记未读 |

```json
{
  "read": true
}
```

`200 OK`：

```json
{
  "ok": true,
  "read": true
}
```

服务端先写入远端 IMAP，成功后才更新本地缓存。

可能的业务错误：

- `400 VALIDATION_ERROR`
- `404 MESSAGE_NOT_FOUND`
- `502 IMAP_UPDATE_FAILED`

### 6.4 标记账号内缓存邮件全部已读

```http
POST /api/v1/accounts/:id/messages/read-all
```

入参：路径参数 `id` 为账号 ID，无请求体。

完全成功时返回 `200 OK`，部分文件夹失败时返回 `207 Multi-Status`。两种状态码的响应结构相同：

```json
{
  "count": 12,
  "failedFolders": []
}
```

部分成功示例：

```http
HTTP/1.1 207 Multi-Status
Content-Type: application/json

{
  "count": 10,
  "failedFolders": ["junk"]
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `count` | `integer` | 本次成功写入远端并更新本地缓存的邮件数 |
| `failedFolders` | `FolderKind[]` | 更新失败的文件夹；空数组表示全部成功 |

调用方不能只把 `2xx` 当作完全成功，必须检查 `failedFolders`。该操作只处理当前保留在本地缓存中的未读邮件。

可能的业务错误：

- `404 ACCOUNT_NOT_FOUND`
- `502 IMAP_UPDATE_FAILED`：连接级失败导致无法处理任何文件夹 |

## 7. 设置接口

### 7.1 查询设置

```http
GET /api/v1/settings
```

入参：无。

`200 OK`：

```json
{
  "maxMessagesPerAccount": 100,
  "pollIntervalSeconds": 10
}
```

| 字段 | 类型 | 范围 | 说明 |
| --- | --- | --- | --- |
| `maxMessagesPerAccount` | `integer` | 1–10000 | 每个账号在收件箱和垃圾箱之间合计保留的最大缓存邮件数 |
| `pollIntervalSeconds` | `integer` | 5–3600 | 不支持 IDLE 的会话轮询间隔；支持 IDLE 的会话不按此间隔轮询 |

### 7.2 修改设置

```http
PATCH /api/v1/settings
```

请求体至少包含一个字段：

```json
{
  "maxMessagesPerAccount": 200,
  "pollIntervalSeconds": 30
}
```

`200 OK`：返回修改后的完整设置对象。

降低 `maxMessagesPerAccount` 会立即清理超出保留窗口的本地缓存，并通过 SSE 发送对应的 `messages.changed.deletedIds`；不会删除远端邮件。

可能的业务错误：`400 VALIDATION_ERROR`。

## 8. SSE 事件接口

### 8.1 建立连接

```http
GET /api/v1/events
Accept: text/event-stream
Authorization: Bearer <IMAP2API_TOKEN>
```

可选 Query 参数：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `accountId` | `string(UUID)` | 只接收该账号的 `messages.changed` 和 `account.changed`；`ready` 始终会发送 |

浏览器原生 `EventSource` 不能设置 Bearer Header，因此浏览器集成必须使用 `fetch()` 读取响应流。Token 不得放入 URL。

```ts
const controller = new AbortController();
const response = await fetch(`${baseUrl}/events`, {
  headers: {
    Accept: "text/event-stream",
    Authorization: `Bearer ${token}`
  },
  signal: controller.signal
});

if (!response.ok || !response.body) {
  throw new Error(`SSE connection failed: ${response.status}`);
}

// 使用项目选定的 SSE 解析器消费 response.body。
// 页面卸载或退出登录时调用 controller.abort()。
```

成功响应头：

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

服务端约每 15 秒发送一次 SSE 注释心跳：

```text
: ping

```

### 8.2 `ready`

连接建立后立即发送：

```text
id: <server-boot-id>:1
event: ready
data: {"serverTime":"2026-08-07T10:30:00.000Z"}

```

`data` 字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `serverTime` | `string` | 服务端当前时间 |

### 8.3 `messages.changed`

邮件缓存新增、更新或删除后发送：

```text
id: <server-boot-id>:2
event: messages.changed
data: {"accountId":"5f3deca8-7aa3-489a-bcf5-03ca02fb7474","folder":"inbox","addedIds":["f3380887-4238-439b-9636-b166ec51e270"],"updatedIds":[],"deletedIds":[],"occurredAt":"2026-08-07T10:30:01.000Z"}

```

`data` 字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `accountId` | `string(UUID)` | 账号 ID |
| `folder` | `FolderKind` | 发生变化的文件夹 |
| `addedIds` | `string[]` | 新增的本地邮件 ID |
| `updatedIds` | `string[]` | 内容或已读状态更新的本地邮件 ID |
| `deletedIds` | `string[]` | 从本地缓存删除的邮件 ID |
| `occurredAt` | `string` | 事件产生时间 |

事件只携带缓存变更元数据，不携带主题、地址、正文或凭据。收到事件后，调用方应按需重新请求邮件列表或详情。

### 8.4 `account.changed`

账号连接、同步模式或最近同步时间变化后发送：

```text
id: <server-boot-id>:3
event: account.changed
data: {"accountId":"5f3deca8-7aa3-489a-bcf5-03ca02fb7474","status":"connected","syncMode":"idle","lastSyncedAt":"2026-08-07T10:30:01.000Z","occurredAt":"2026-08-07T10:30:01.000Z"}

```

`data` 字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `accountId` | `string(UUID)` | 账号 ID |
| `status` | `ConnectionStatus` | 最新连接状态 |
| `syncMode` | `SyncMode \| null` | 最新同步模式 |
| `lastSyncedAt` | `string \| null` | 最近一次成功同步时间 |
| `occurredAt` | `string` | 事件产生时间 |

### 8.5 重连约定

- 当前服务不提供事件历史，也不会根据 `Last-Event-ID` 重放断线期间的事件。
- SSE 断线重连成功并收到 `ready` 后，应重新查询账号和相关邮件列表，以服务端当前状态为准。
- 客户端应采用带上限的退避重连，并在退出登录或组件卸载时取消连接。
- 反向代理必须关闭 SSE 响应缓冲，并允许长期连接。

## 9. 错误响应

所有 API 错误统一使用：

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "请求参数无效",
    "details": {}
  }
}
```

| 字段 | 类型 | 必有 | 说明 |
| --- | --- | --- | --- |
| `error.code` | `string` | 是 | 稳定的机器可读错误码 |
| `error.message` | `string` | 是 | 面向调用方的错误说明 |
| `error.details` | `unknown` | 否 | 参数校验详情；调用方不应依赖其内部结构长期稳定 |

已知错误码：

| HTTP 状态码 | 错误码 | 含义 |
| --- | --- | --- |
| `400` | `VALIDATION_ERROR` | 请求体、Query、字段范围或分页游标无效 |
| `401` | `UNAUTHORIZED` | Bearer Token 缺失或错误 |
| `404` | `ACCOUNT_NOT_FOUND` | 账号不存在 |
| `404` | `MESSAGE_NOT_FOUND` | 邮件不存在或已离开本地缓存 |
| `404` | `NOT_FOUND` | API 路径不存在 |
| `409` | `ACCOUNT_EXISTS` | 相同主邮箱账号已存在 |
| `502` | `IMAP_CONNECTION_FAILED` | IMAP 连接测试失败 |
| `502` | `IMAP_UPDATE_FAILED` | 远端 IMAP 已读写操作失败 |
| `500` | `INTERNAL_ERROR` | 未处理的服务端错误 |

调用建议：

- 以 HTTP 状态码判断请求大类结果，以 `error.code` 实现具体分支，不要匹配中文 `message`。
- `401` 不应自动无限重试，应要求重新配置 Token。
- `502` 表示远端邮箱或网络失败，可做有限次数退避重试。
- `500` 不会返回堆栈、SQLite 错误、凭据或内部路径。
- `207` 不是错误结构，应按“部分成功”解析 `count` 和 `failedFolders`。

## 10. 集成边界与注意事项

- 本 API 读取的是本地加密缓存，不保证每次查询都即时访问远端 IMAP；同步完成状态以账号状态和 SSE 事件为准。
- `maxMessagesPerAccount` 是每个账号跨收件箱与垃圾箱的合计缓存上限；较旧邮件可能不存在于 API 中。
- 邮件 ID 是本地缓存资源 ID。邮件从缓存移除后，对应详情接口会返回 `404 MESSAGE_NOT_FOUND`。
- 已读接口会修改远端邮箱状态；删除账号和调整缓存上限只修改本地数据，不删除远端邮件。
- 普通附件只返回文件名，不缓存附件内容，也没有附件下载接口。
- 当前认证模型是单个服务级 Bearer Token，没有按调用方、账号或接口划分权限。对外提供能力时，建议由集成方自己的后端代理调用，不要把 Token 下发到不可信客户端。
- 服务端当前未声明跨域访问策略。浏览器跨域集成应通过同源后端代理或在受控反向代理层配置严格的 CORS。

## 11. TypeScript 类型来源

仓库内可复用的公共类型位于 `packages/shared/src/index.ts`，包名为 `@imap2api/shared`。它提供 `Account`、`AccountInput`、`AccountUpdate`、`MessageSummary`、`MessageDetail`、`MessageListResponse`、`Settings`、`SyncTriggerResult`、`ReadAllResult`、`ServerEvent` 和 `ApiError` 等类型。

这些类型适合仓库内或受控的 TypeScript 集成。跨语言、跨版本集成仍应以本文档描述的 HTTP JSON/SSE 线格式为边界，并在升级服务版本时重新核对契约。

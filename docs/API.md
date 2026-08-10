# email2api HTTP API 接口说明

本文档面向需要把 email2api 邮箱能力集成到其他项目的开发者，描述当前 `v1` 接口的认证方式、入参、出参、错误和 SSE 事件格式。

## 1. 接入信息

- API 基础地址：`http(s)://<host>:<port>/api/v1`
- 默认本地地址：`http://localhost:3000/api/v1`
- 数据格式：普通接口使用 JSON；发信请求使用 multipart；附件下载返回二进制流；SSE 返回事件流；`204 No Content` 无响应体
- 字符编码：UTF-8
- 时间格式：带时区的 ISO 8601 字符串，例如 `2026-08-07T10:30:00.000Z`
- 账号 ID 和邮件 ID：UUID 字符串；附件 ID 和分页游标是不透明字符串，调用方不得自行解析

生产环境必须通过 HTTPS 调用，避免 Bearer Token 和邮件内容经明文网络传输。

### 1.1 认证

除 `GET /healthz` 外，所有接口都必须携带服务端环境变量 `EMAIL2API_TOKEN` 对应的 Bearer Token：

```http
Authorization: Bearer <EMAIL2API_TOKEN>
```

`EMAIL2API_TOKEN` 在服务启动时必须至少包含 32 个字符，并同时用于本地数据库密钥派生。已有数据库不能直接更换 Token；当前 API 不提供 Token 轮换、刷新或按账号授权能力。

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
export EMAIL2API_BASE_URL='http://localhost:3000/api/v1'
export EMAIL2API_TOKEN='replace-with-your-token'

curl -X POST \
  -H "Authorization: Bearer $EMAIL2API_TOKEN" \
  "$EMAIL2API_BASE_URL/auth/verify"
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
| `SyncMode` | `idle`, `polling` | 系统邮箱主会话使用实时 IDLE 或定时轮询；尚未建立会话时为 `null` |
| `SyncFolderMode` | `idle`, `polling` | 自定义同步文件夹请求使用独立 IDLE 连接或账号级共享轮询连接；服务器不支持 IDLE 时会降级 |
| `MessageView` | `all`, `unread`, `junk` | 邮件列表视图 |
| `MessageSecondaryFilter` | `verification_code`, `attachment`, `forwarded` | 邮件列表的可组合次级筛选条件 |
| `FolderKind` | `inbox`, `junk` | 收件箱或垃圾箱 |
| `MessageLabel` | `forwarded`, `verification_code`, `unsubscribe` | 转发邮件、验证码邮件、退订邮件 |

连接状态含义：

| 状态 | 含义 |
| --- | --- |
| `pending` | 账号刚创建，或 IMAP/同步文件夹配置刚更新，等待连接 |
| `connecting` | 正在连接或初始化任一已配置邮箱文件夹 |
| `connected` | 收件箱及其他已配置同步会话均正常工作 |
| `warning` | 收件箱可用，但垃圾箱或自定义文件夹缺失、失败，或自定义 IDLE 已降级为轮询 |
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
| `smtp` | `object \| null` | 实际 SMTP 配置；自定义账号未配置时为 `null` |
| `smtp.host` | `string` | SMTP 主机 |
| `smtp.port` | `integer` | SMTP 端口 |
| `smtp.secure` | `boolean` | `true` 为隐式 TLS，`false` 为强制 STARTTLS |
| `defaultSenderName` | `string \| null` | 账号级默认发件人名称 |
| `hasCredential` | `true` | 表示服务端已保存凭据，不代表返回了凭据 |
| `status` | `ConnectionStatus` | 当前连接状态 |
| `syncMode` | `SyncMode \| null` | 收件箱优先、垃圾箱回退的系统邮箱同步模式；自定义文件夹模式从文件夹接口读取 |
| `messageCount` | `integer` | 当前账号的本地缓存邮件总数 |
| `unreadCount` | `integer` | 当前账号的本地未读邮件数 |
| `syncFolderCount` | `integer` | 已选择的自定义同步文件夹数，不含系统收件箱和垃圾箱 |
| `lastSyncedAt` | `string \| null` | 任一已配置文件夹最近一次成功同步时间，不表示所有文件夹均成功 |
| `lastError` | `string \| null` | 最近连接错误摘要 |
| `createdAt` | `string` | 创建时间 |
| `updatedAt` | `string` | 账号记录更新时间；连接状态或同步模式变化也会更新该字段 |

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
| `forwardedVia` | `string \| null` | 检测到的转发中转邮箱地址；未识别时为 `null` |

### 2.5 `MessageDetail`

`MessageDetail` 包含 `MessageSummary` 的全部字段，并增加：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `to` | `Address[]` | 收件人列表 |
| `cc` | `Address[]` | 抄送人列表 |
| `attachments` | `MessageAttachment[]` | 附件元数据；内容不进入本地缓存 |
| `text` | `string` | 纯文本正文 |
| `html` | `string \| null` | 经服务端净化的 HTML 正文 |
| `verificationCode` | `string \| null` | 自动提取的验证码 |
| `unsubscribeUrl` | `string \| null` | 自动识别的退订链接 |

`MessageAttachment` 字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `string \| null` | 下载附件使用的不透明 ID；旧缓存尚未完成元数据回填时为 `null` |
| `filename` | `string` | 附件文件名 |
| `contentType` | `string` | MIME 类型，未知时为 `application/octet-stream` |
| `size` | `integer \| null` | IMAP 服务器报告的预计字节数，未知时为 `null` |

## 3. 接口总览

| 方法 | 路径 | 认证 | 成功状态码 | 作用 |
| --- | --- | --- | --- | --- |
| `GET` | `/healthz` | 否 | `200` | 健康检查，路径不含 `/api/v1` |
| `POST` | `/auth/verify` | 是 | `200` | 验证 Token |
| `GET` | `/accounts` | 是 | `200` | 查询账号列表 |
| `POST` | `/accounts` | 是 | `201` | 新增账号 |
| `PUT` | `/accounts/order` | 是 | `200` | 更新全部账号的显示顺序 |
| `PATCH` | `/accounts/:id` | 是 | `200` | 更新账号 |
| `DELETE` | `/accounts/:id` | 是 | `204` | 删除账号及其本地缓存 |
| `POST` | `/accounts/:id/test` | 是 | `200` | 测试 IMAP 连接 |
| `POST` | `/accounts/:id/smtp/test` | 是 | `200` | 测试 SMTP 连接 |
| `POST` | `/accounts/:id/sync` | 是 | `202` | 触发同步 |
| `GET` | `/accounts/:id/mailboxes` | 是 | `200` | 查询系统与可选自定义文件夹 |
| `PUT` | `/accounts/:id/sync-folders` | 是 | `200` | 更新自定义同步文件夹及同步模式 |
| `GET` | `/messages` | 是 | `200` | 分页查询邮件摘要 |
| `GET` | `/messages/:id` | 是 | `200` | 查询邮件详情 |
| `POST` | `/messages/send` | 是 | `200` / `207` | 通过 SMTP 发送邮件和附件 |
| `GET` | `/messages/:id/attachments/:attachmentId` | 是 | `200` | 按需下载附件 |
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

`200 OK`：返回 `Account[]`，按已保存的账号顺序排列；尚未显式排序时保持创建顺序。

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
    "smtp": {
      "host": "smtp.gmail.com",
      "port": 465,
      "secure": true
    },
    "defaultSenderName": "Operations",
    "hasCredential": true,
    "status": "connected",
    "syncMode": "idle",
    "messageCount": 128,
    "unreadCount": 7,
    "syncFolderCount": 2,
    "lastSyncedAt": "2026-08-07T10:30:00.000Z",
    "lastError": null,
    "createdAt": "2026-08-07T10:00:00.000Z",
    "updatedAt": "2026-08-07T10:30:00.000Z"
  }
]
```

### 5.2 更新账号顺序

```http
PUT /api/v1/accounts/order
Content-Type: application/json
```

请求体必须提供当前全部账号 ID，数组顺序就是后续 `GET /accounts` 的返回顺序：

| 字段 | 类型 | 必填 | 约束与说明 |
| --- | --- | --- | --- |
| `accountIds` | `string(UUID)[]` | 是 | 最多 1000 项；不得重复，且必须与当前账号集合完全一致 |

```json
{
  "accountIds": [
    "f00ee764-a592-484a-81f0-309e41a05813",
    "5f3deca8-7aa3-489a-bcf5-03ca02fb7474"
  ]
}
```

`200 OK`：返回按新顺序排列的完整 `Account[]`。

可能的业务错误：`400 VALIDATION_ERROR`。如果排序期间账号集合已变化，调用方应重新查询账号列表后再提交完整顺序。排序完成后新建的账号会追加到末尾。

### 5.3 新增账号

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
| `smtp` | `object \| null` | 否 | SMTP 主机、端口和安全模式；`null` 表示使用服务商预设，自定义账号为仅收信状态 |
| `smtp.host` | `string` | 否 | 最长 255 字符；自定义 SMTP 必须提供 |
| `smtp.port` | `integer` | 否 | 1–65535，默认使用预设值或 `465` |
| `smtp.secure` | `boolean` | 否 | `true` 使用隐式 TLS；`false` 强制 STARTTLS |
| `defaultSenderName` | `string \| null` | 否 | 最长 200 字符且不能包含 CR/LF；`null`、空字符串或纯空白表示继承系统设置 |

已内置 `qq`、`gmail`、`icloud`、`outlook`、`qq-enterprise`、`163` 的 IMAP 预设。Gmail、iCloud、QQ、163 等邮箱通常需要应用专用密码或授权码；当前接口不支持 OAuth 登录。

对应 SMTP 预设为 `smtp.qq.com:465`、`smtp.gmail.com:465`、`smtp.mail.me.com:587`、`smtp-mail.outlook.com:587`、`smtp.exmail.qq.com:465` 和 `smtp.163.com:465`。587 端口配置强制 STARTTLS，不允许明文降级。

更新账号时若改变 `imap.provider` 且未同时提交 `smtp`，服务端会按新服务商重新解析 SMTP：内置服务商使用对应预设，自定义服务商变为 `null`。

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

### 5.4 更新账号

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

`200 OK`：返回更新后的 `Account`。修改 `email`、`password` 或 `imap` 会重置连接状态并重启同步会话；只修改 `smtp`、`defaultSenderName` 或 `aliases` 不会重启 IMAP。修改邮箱或别名会重新分类已缓存邮件。

修改 `email` 但省略 `imap` 时会保留账号当前已解析的 IMAP 服务商和连接参数，不会按新域名重新自动识别。需要重新识别时，应同时提交：

```json
{
  "email": "new-address@outlook.com",
  "imap": {
    "provider": "auto"
  }
}
```

可能的业务错误：

- `400 VALIDATION_ERROR`
- `404 ACCOUNT_NOT_FOUND`
- `409 ACCOUNT_EXISTS`

### 5.5 删除账号

```http
DELETE /api/v1/accounts/:id
```

入参：路径参数 `id` 为账号 ID，无请求体。

`204 No Content`：成功，无响应体。操作会停止该账号的同步会话，并删除账号及其本地邮件缓存；不会删除远端邮箱中的邮件。

可能的业务错误：`404 ACCOUNT_NOT_FOUND`。

### 5.6 测试 IMAP 连接

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

### 5.7 测试 SMTP 连接

```http
POST /api/v1/accounts/:id/smtp/test
```

入参：路径参数 `id` 为账号 ID，无请求体。接口使用账号主邮箱和现有授权码验证 SMTP，不会发送实际邮件。

`200 OK`：

```json
{
  "ok": true
}
```

可能的业务错误：`400 SMTP_NOT_CONFIGURED`、`404 ACCOUNT_NOT_FOUND`、`502 SMTP_CONNECTION_FAILED`。

### 5.8 触发同步

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

### 5.9 查询可同步文件夹

```http
GET /api/v1/accounts/:id/mailboxes
```

接口会即时连接远端 IMAP 并返回文件夹列表。收件箱和垃圾箱由系统强制同步，`selectable` 为 `false`；其他无 special-use 且不含 `\\Noselect` 的文件夹可由用户选择。已配置但远端暂时缺失的文件夹仍会返回，`available` 为 `false`。

```json
{
  "items": [
    {
      "path": "INBOX/Forwarded",
      "name": "Forwarded",
      "depth": 1,
      "kind": "custom",
      "selectable": true,
      "available": true,
      "selectedMode": "polling",
      "cachedMessageCount": 28
    }
  ]
}
```

`items` 中每一项的字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `path` | `string` | IMAP 文件夹完整路径，后续配置时原样回传 |
| `name` | `string` | 文件夹名称 |
| `depth` | `integer` | 按服务端分隔符计算的层级深度，顶层为 `0` |
| `kind` | `inbox \| junk \| custom` | 系统收件箱、系统垃圾箱或可选自定义文件夹 |
| `selectable` | `boolean` | 是否允许出现在 `sync-folders` 入参中 |
| `available` | `boolean` | 当前远端是否仍存在该文件夹 |
| `selectedMode` | `SyncFolderMode \| null` | 自定义文件夹保存的请求模式；未选择或系统文件夹为 `null`，不代表降级后的有效模式 |
| `cachedMessageCount` | `integer` | 该真实 IMAP 文件夹当前的本地缓存邮件数 |

文件夹路径来自 IMAP 服务器，客户端应按普通文本处理。服务端只在加密配置和加密邮件传输信息中保存路径。

可能的业务错误：`404 ACCOUNT_NOT_FOUND`、`502 IMAP_MAILBOX_LIST_FAILED`。

### 5.10 更新同步文件夹

```http
PUT /api/v1/accounts/:id/sync-folders
Content-Type: application/json

{
  "folders": [
    { "path": "INBOX/Forwarded", "mode": "idle" },
    { "path": "Archive/Receipts", "mode": "polling" }
  ]
}
```

请求体：

| 字段 | 类型 | 必填 | 约束与说明 |
| --- | --- | --- | --- |
| `folders` | `SyncFolderConfig[]` | 是 | 自定义同步文件夹的完整目标配置，最多 20 项；空数组表示取消全部自定义文件夹 |
| `folders[].path` | `string` | 是 | 去除首尾空格后长度 1–1000；不得重复 |
| `folders[].mode` | `SyncFolderMode` | 是 | `idle` 或 `polling` |

- 每个账号最多选择 20 个自定义文件夹，其中最多 5 个使用 `idle`。
- 新增的路径必须存在且可选择；远端暂时缺失的已配置路径可以继续保留。
- `idle` 文件夹通常各使用一个长期连接；服务器不支持 IDLE 时会降级到轮询并把账号置为 `warning`，但保存的 `selectedMode` 仍为 `idle`。`polling` 文件夹在账号内共享一个连接并顺序同步。
- 取消选择会删除该文件夹的本地缓存并通过 SSE 发送删除 ID，不会删除远端邮件。
- 自定义文件夹邮件在公开邮件列表中继续使用 `folder: "inbox"`，不会通过 API 或 SSE 暴露真实路径。

`200 OK`：返回更新后的 `Account`，同步会话随后按新配置重启。

可能的错误：`400 VALIDATION_ERROR`、`404 ACCOUNT_NOT_FOUND`、`502 IMAP_SYNC_FOLDER_UPDATE_FAILED`。

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
| `filter` | `MessageSecondaryFilter` | 否 | 无 | 可重复传入，最多 3 项；多个条件按 AND 关系组合 |
| `after` | `string(datetime)` | 否 | 无 | `displayTime >= after` |
| `before` | `string(datetime)` | 否 | 无 | `displayTime < before` |
| `cursor` | `string` | 否 | 无 | 上一页返回的 `nextCursor`，最长 1000 字符；调用方不得解析或修改 |
| `limit` | `integer` | 否 | `100` | 1–100 |

`after` 和 `before` 必须为带时区的 ISO 8601 时间。结果按 `displayTime` 降序排列；时间相同时按邮件 ID 降序排列。

`filter` 必须使用重复 Query 参数传递，不使用逗号拼接：

- `verification_code`：包含验证码标签。
- `attachment`：包含至少一个附件。
- `forwarded`：包含转发标签。

请求示例：

```http
GET /api/v1/messages?accountId=5f3deca8-7aa3-489a-bcf5-03ca02fb7474&view=unread&filter=verification_code&filter=attachment&after=2026-08-01T00%3A00%3A00.000Z&limit=20
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
      "hasAttachments": true,
      "labels": ["verification_code"],
      "forwardedVia": null
    }
  ],
  "nextCursor": "WyIyMDI2LTA4LTA3VDEwOjI1OjAwLjAwMFoiLCJmMzM4MDg4Ny00MjM4LTQzOWItOTYzNi1iMTY2ZWM1MWUyNzAiXQ",
  "total": 128
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `items` | `MessageSummary[]` | 当前页邮件摘要 |
| `nextCursor` | `string \| null` | 下一页游标；为 `null` 时没有下一页 |
| `total` | `integer` | 当前账号、视图、筛选和时间范围下的邮件总数，不受 `cursor` 影响 |

分页时应保留首个请求的 `accountId`、`view`、全部 `filter`、`after`、`before` 和 `limit`，仅追加或替换 `cursor`。游标依赖当前排序边界，缓存变化后可能出现正常的跨页漂移；对一致性敏感的调用方应在收到 SSE 变更事件后从第一页重新查询。

`accountId` 只作为筛选条件使用；传入格式正确但不存在的账号 ID 时，接口返回 `200`、空 `items`、`nextCursor: null` 和 `total: 0`，不会返回 `ACCOUNT_NOT_FOUND`。

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
  "forwardedVia": null,
  "to": [
    {
      "address": "user@gmail.com"
    }
  ],
  "cc": [],
  "attachments": [
    {
      "id": "-3e7H_XvY9T5jM2Q",
      "filename": "invoice.pdf",
      "contentType": "application/pdf",
      "size": 2048
    }
  ],
  "text": "Use 123456 to complete verification.",
  "html": "<p>Use <strong>123456</strong> to complete verification.</p>",
  "verificationCode": "123456",
  "unsubscribeUrl": null
}
```

可能的业务错误：`404 MESSAGE_NOT_FOUND`。

HTML 线格式约定：

- 外部链接只保留 `http:`、`https:`、`mailto:`，目标地址放在 `<a data-safe-href="...">`，不会直接放入 `href`。宿主应用应拦截点击、重新校验协议并由用户确认后打开。
- 远程 HTTP(S) 图片地址放在 `<img data-remote-src="...">`，默认没有 `src`。只有调用方依据设置或用户操作明确允许时，才应把它复制到 `src`。
- 通过内容和大小校验的 CID 内嵌 PNG、JPEG、GIF、WebP 会以内联 `data:` URL 保留；单张最多 2 MiB、每封邮件合计最多 5 MiB、最多 32 张。
- `verificationCode` 只提取验证码关键词附近、包含数字的 4–8 位字母数字组合；`unsubscribeUrl` 只返回退订上下文中的安全 HTTP(S) 地址。自动识别结果可能为 `null`，不能替代业务侧校验。

安全注意：虽然 `html` 已由服务端净化，集成方仍应使用隔离且禁止脚本、弹窗、表单提交和顶层导航的 sandbox iframe 展示，不能直接注入应用 DOM。建议额外设置拒绝脚本、对象、frame、表单和默认网络访问的 CSP，并使用 `no-referrer`；只有明确允许远程图片时才单独放宽 `img-src`。

### 6.3 下载附件

```http
GET /api/v1/messages/:id/attachments/:attachmentId
Authorization: Bearer <EMAIL2API_TOKEN>
```

路径参数：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `string(UUID)` | 本地邮件 ID |
| `attachmentId` | `string` | 邮件详情中非 `null` 的附件 `id`，按不透明字符串原样使用 |

服务端使用邮件缓存中的账号、真实文件夹、UID、UIDVALIDITY 和附件 MIME part，从远端 IMAP 按需读取并返回二进制流。附件内容不会写入 SQLite 或本地文件系统。

`200 OK`：响应体为附件二进制流，不是 JSON。响应包含：

| Header | 说明 |
| --- | --- |
| `Content-Type` | 安全规范化后的附件 MIME 类型；无效或未知时为 `application/octet-stream` |
| `Content-Disposition` | `attachment`，同时提供 ASCII 回退文件名和 UTF-8 文件名 |
| `Cache-Control` | 固定为 `private, no-store` |
| `X-Content-Type-Options` | 固定为 `nosniff` |

下载不支持 HTTP Range、断点续传或批量 ZIP，也不保证返回 `Content-Length`。附件元数据 `id` 为 `null` 时不可调用下载接口，应等待同步完成元数据回填。

附件下载并发由 `maxConcurrentDownloads` 控制；其余请求按 FIFO 排队，最多等待 50 个，排队超过 30 秒返回 `DOWNLOAD_QUEUE_TIMEOUT`。降低并发设置不会中断已经开始的下载，只影响后续调度。

可能的业务错误：

- `404 MESSAGE_NOT_FOUND`
- `404 ATTACHMENT_NOT_FOUND`
- `410 ATTACHMENT_STALE`：远端邮箱 UIDVALIDITY 已变化，需要先同步
- `413 ATTACHMENT_TOO_LARGE`
- `429 DOWNLOAD_QUEUE_FULL`
- `429 DOWNLOAD_QUEUE_TIMEOUT`
- `502 IMAP_DOWNLOAD_FAILED`

### 6.4 标记单封邮件已读或未读

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

### 6.5 标记账号内缓存邮件全部已读

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
| `failedFolders` | `FolderKind[]` | 更新失败的公开文件夹类别；空数组表示全部成功，自定义文件夹失败归入 `inbox` |

调用方不能只把 `2xx` 当作完全成功，必须检查 `failedFolders`。该操作只处理当前保留在本地缓存中的未读邮件。

可能的业务错误：

- `404 ACCOUNT_NOT_FOUND`
- `502 IMAP_UPDATE_FAILED`：连接级失败导致无法处理任何文件夹

### 6.6 发送邮件

```http
POST /api/v1/messages/send
Content-Type: multipart/form-data; boundary=<generated-boundary>
```

请求必须包含一个名为 `message` 的文本字段，其值为 JSON；每个附件使用同名 `attachments` 文件字段：

multipart 字段：

| 字段 | 类型 | 必填 | 约束与说明 |
| --- | --- | --- | --- |
| `message` | 文本字段 | 是 | 只允许一个，内容为下表所述 JSON；整个字段最多 1 MiB + 64 KiB |
| `attachments` | 文件字段 | 否 | 可重复，最多 20 个；文件名和 MIME 类型会被安全规范化 |

`message` JSON：

| 字段 | 类型 | 必填 | 约束与说明 |
| --- | --- | --- | --- |
| `accountId` | `string(UUID)` | 是 | 用于 SMTP 登录的账号 ID |
| `fromAddress` | `string(email)` | 是 | 账号主邮箱或已配置别名；服务端会转为小写 |
| `senderName` | `string` | 否 | 最长 200 字符，不得包含 CR/LF；省略、空字符串或纯空白时使用账号级或系统级默认值 |
| `to` | `string(email)[]` | 是 | 主收件人数组，可为空；单数组最多 100 项 |
| `cc` | `string(email)[]` | 否 | 抄送人数组，最多 100 项 |
| `bcc` | `string(email)[]` | 否 | 密送人数组，最多 100 项 |
| `subject` | `string` | 是 | 最长 998 字符，不得包含 CR/LF |
| `html` | `string` | 是 | 最长 1 MiB；没有附件时，净化并转成纯文本后不得为空 |

`to`、`cc`、`bcc` 三组收件人合计必须为 1–100 个。

```json
{
  "accountId": "5f3deca8-7aa3-489a-bcf5-03ca02fb7474",
  "fromAddress": "alias@example.com",
  "senderName": "Operations",
  "to": ["recipient@example.com"],
  "cc": [],
  "bcc": [],
  "subject": "Status report",
  "html": "<p>Report attached.</p>"
}
```

- `fromAddress` 必须是账号主邮箱或已配置别名；SMTP 登录始终使用主邮箱和账号授权码。
- 发件人名称按请求值、账号默认值、系统默认值的顺序解析。
- 最多 20 个附件；单件及总大小均不能超过 `maxAttachmentSizeMb`。文件名中的控制字符、`/` 和 `\` 会替换为 `_`，最长保留 255 个 Unicode 字符；无效 MIME 类型降级为 `application/octet-stream`。附件仅在请求期间临时保存，结束后清理。
- HTML 仅保留段落、三级标题、粗体、斜体、下划线、删除线、引用、分隔线、列表、HTTP(S)/mailto 链接和表格。表格只允许 `border-collapse: collapse`、`width: 100%`、`table-layout: fixed`；单元格只允许实现内置表格样式所需的边框、内边距、顶部对齐、表头背景和左对齐，并同时生成纯文本正文。

完整成功返回 `200 OK`，部分收件人被拒绝返回 `207 Multi-Status`：

```json
{
  "messageId": "<message-id@example.com>",
  "accepted": ["recipient@example.com"],
  "rejected": []
}
```

调用方必须检查 `rejected`。服务端不保存草稿、发信历史或“已发送”副本。

| 出参字段 | 类型 | 说明 |
| --- | --- | --- |
| `messageId` | `string` | SMTP 服务器返回的消息 ID |
| `accepted` | `string[]` | SMTP 服务器接受的收件地址 |
| `rejected` | `string[]` | SMTP 服务器拒绝的收件地址；非空时 HTTP 状态码为 `207` |

`SMTP_RECIPIENTS_REJECTED` 表示全部收件人被拒绝，其 `error.details` 为 `{ "rejected": string[] }`。

可能的业务错误：`400 VALIDATION_ERROR`、`400 SMTP_NOT_CONFIGURED`、`404 ACCOUNT_NOT_FOUND`、`413 ATTACHMENT_TOO_LARGE`、`413 ATTACHMENT_TOTAL_TOO_LARGE`、`502 SMTP_RECIPIENTS_REJECTED`、`502 SMTP_SEND_FAILED`。

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
  "pollIntervalSeconds": 10,
  "pageSize": 100,
  "maxConcurrentDownloads": 3,
  "maxAttachmentSizeMb": 100,
  "autoLoadRemoteImages": false,
  "remoteImageAllowlist": [],
  "defaultSenderName": ""
}
```

| 字段 | 类型 | 范围 | 说明 |
| --- | --- | --- | --- |
| `maxMessagesPerAccount` | `integer` | 1–10000 | 每个账号在所有已同步文件夹中合计保留的最大缓存邮件数 |
| `pollIntervalSeconds` | `integer` | 5–3600 | 所有轮询会话和共享轮询组的间隔；正在使用 IDLE 的会话不按此间隔轮询 |
| `pageSize` | `integer` | 10–100 | 管理端邮件列表每页加载的邮件数量 |
| `maxConcurrentDownloads` | `integer` | 1–10 | 单进程内所有账号共享的附件并发下载上限 |
| `maxAttachmentSizeMb` | `integer` | 1–1024 | 单附件下载、发信单附件及单次发信附件总量上限；按 MiB（1024 × 1024 字节）计算 |
| `autoLoadRemoteImages` | `boolean` | - | 客户端是否为所有邮件自动加载远程图片；启用后客户端应忽略发件人白名单限制 |
| `remoteImageAllowlist` | `string[]` | 最多 200 项 | 客户端打开邮件时允许自动加载远程图片的完整发件人邮箱地址 |
| `defaultSenderName` | `string` | 最多 200 字符 | 系统默认发件人名称；空字符串表示不设置 |

### 7.2 修改设置

```http
PATCH /api/v1/settings
```

请求体至少包含一个字段：

```json
{
  "maxMessagesPerAccount": 200,
  "pollIntervalSeconds": 30,
  "pageSize": 60,
  "maxConcurrentDownloads": 4,
  "maxAttachmentSizeMb": 200,
  "autoLoadRemoteImages": true,
  "remoteImageAllowlist": ["trusted@example.com", "images@example.com"],
  "defaultSenderName": "Operations"
}
```

`200 OK`：返回修改后的完整设置对象。

`remoteImageAllowlist` 的每一项必须是完整邮箱地址，最多 200 项；服务端会去除首尾空格、转为小写并去重。`defaultSenderName` 最长 200 字符且不能包含 CR/LF，空字符串表示清除系统默认发件人名称。

远程图片两个设置只是由服务端持久化并返回的客户端策略。服务端始终以 `data-remote-src` 返回远程图片占位，不会根据设置主动请求图片或改写邮件 HTML；集成方应对 `from[].address` 做去空格、不区分大小写的完整地址匹配后自行执行策略。

降低 `maxMessagesPerAccount` 会立即清理超出保留窗口的本地缓存，并通过 SSE 发送对应的 `messages.changed.deletedIds`；不会删除远端邮件。

可能的业务错误：`400 VALIDATION_ERROR`。

## 8. SSE 事件接口

### 8.1 建立连接

```http
GET /api/v1/events
Accept: text/event-stream
Authorization: Bearer <EMAIL2API_TOKEN>
```

可选 Query 参数：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `accountId` | `string(UUID)` | 只接收该账号的 `messages.changed` 和 `account.changed`；`ready` 始终会发送 |

浏览器原生 `EventSource` 不能设置 Bearer Header，因此浏览器集成必须使用 `fetch()` 读取响应流。Token 不得放入 URL。

`accountId` 只校验 UUID 格式，不校验账号是否存在；不存在时连接仍成功并收到 `ready`，但不会收到该账号的后续变更事件。

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

该事件不包含 `lastError`、计数或完整账号配置；需要错误摘要或完整状态时，应重新调用 `GET /accounts`。

### 8.5 重连约定

- 当前服务不提供事件历史，也不会根据 `Last-Event-ID` 重放断线期间的事件。
- 同一条连接内事件按服务端发布顺序到达，但断线期间的事件可能丢失，事件 ID 在服务重启后使用新的 boot ID。
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
| `404` | `ATTACHMENT_NOT_FOUND` | 附件 ID 不存在或元数据尚未回填 |
| `404` | `NOT_FOUND` | API 路径不存在 |
| `409` | `ACCOUNT_EXISTS` | 相同主邮箱账号已存在 |
| `410` | `ATTACHMENT_STALE` | 远端邮箱已重建，附件引用失效 |
| `413` | `ATTACHMENT_TOO_LARGE` | 附件超过系统设置的大小上限 |
| `413` | `ATTACHMENT_TOTAL_TOO_LARGE` | 单次发信附件总量超过系统设置的大小上限 |
| `429` | `DOWNLOAD_QUEUE_FULL` | 附件下载等待队列已满 |
| `429` | `DOWNLOAD_QUEUE_TIMEOUT` | 附件下载排队超过 30 秒 |
| `502` | `IMAP_CONNECTION_FAILED` | IMAP 连接测试失败 |
| `502` | `IMAP_MAILBOX_LIST_FAILED` | 无法从远端 IMAP 读取文件夹列表 |
| `502` | `IMAP_SYNC_FOLDER_UPDATE_FAILED` | 更新同步文件夹时远端操作失败 |
| `502` | `IMAP_DOWNLOAD_FAILED` | 远端附件下载失败 |
| `502` | `IMAP_UPDATE_FAILED` | 远端 IMAP 已读写操作失败 |
| `400` | `SMTP_NOT_CONFIGURED` | 账号未配置可用的 SMTP 主机 |
| `502` | `SMTP_CONNECTION_FAILED` | SMTP 连接测试失败 |
| `502` | `SMTP_RECIPIENTS_REJECTED` | SMTP 服务器拒绝全部收件人 |
| `502` | `SMTP_SEND_FAILED` | SMTP 投递失败 |
| `500` | `INTERNAL_ERROR` | 未处理的服务端错误 |

调用建议：

- 以 HTTP 状态码判断请求大类结果，以 `error.code` 实现具体分支，不要匹配中文 `message`。
- `401` 不应自动无限重试，应要求重新配置 Token。
- `502` 表示远端邮箱或网络失败，可做有限次数退避重试。
- `500` 不会返回堆栈、SQLite 错误、凭据或内部路径。
- `207` 不是错误结构；批量已读检查 `failedFolders`，发信检查 `rejected`。

## 10. 集成边界与注意事项

- 本 API 读取的是本地加密缓存，不保证每次查询都即时访问远端 IMAP；同步完成状态以账号状态和 SSE 事件为准。
- `maxMessagesPerAccount` 是每个账号跨所有已同步文件夹的合计缓存上限；较旧邮件可能不存在于 API 中。
- 邮件 ID 是本地缓存资源 ID。邮件从缓存移除后，对应详情接口会返回 `404 MESSAGE_NOT_FOUND`。
- 已读接口会修改远端邮箱状态；删除账号和调整缓存上限只修改本地数据，不删除远端邮件。
- 附件只在请求下载时从远端 IMAP 流式读取；本地加密缓存仅保存附件元数据，不保存附件内容。
- 发信接口没有幂等键或重复投递检测。网络超时或连接中断后，调用方不能盲目自动重试，否则可能发送重复邮件。
- 当前认证模型是单个服务级 Bearer Token，没有按调用方、账号或接口划分权限。对外提供能力时，建议由集成方自己的后端代理调用，不要把 Token 下发到不可信客户端。
- 服务端当前未声明跨域访问策略，也没有内置调用方级限流。浏览器跨域集成应通过同源后端代理或在受控反向代理层配置严格的 CORS、访问控制和限流。

## 11. TypeScript 类型来源

仓库内可复用的公共类型位于 `packages/shared/src/index.ts`，包名为 `@email2api/shared`。它提供 `Account`、`AccountInput`、`AccountUpdate`、`AccountOrderUpdate`、`MailboxListResponse`、`SyncFoldersUpdate`、`MessageSummary`、`MessageDetail`、`MessageListResponse`、`SendMailInput`、`SendMailResult`、`Settings`、`SyncTriggerResult`、`ReadAllResult`、`ServerEvent` 和 `ApiError` 等类型。

这些类型适合仓库内或受控的 TypeScript 集成。跨语言、跨版本集成仍应以本文档描述的 HTTP JSON/SSE 线格式为边界，并在升级服务版本时重新核对契约。

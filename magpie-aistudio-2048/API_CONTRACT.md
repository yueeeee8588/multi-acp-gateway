# AIStudio2API 管理端与数据面 API 契约（实测取证）

> 取证目标：`http://127.0.0.1:2048`（实测运行版本 `AIStudio2API v0.3.13`，预览端口 `127.0.0.1:2050`）
> 取证日期：2026-11-22
> 说明：所有响应状态码与字段均来自运行中的真实进程 `aistudio2api.exe`，敏感凭证与账号邮箱已脱敏。

---

## 1. 管理端鉴权机制

### 1.1 未登录行为
- **`GET /api/auth/session`**：无需登录即可访问，返回 `200 OK`：
  ```json
  {"authenticated":false,"enabled":true,"username":""}
  ```
  - 当 `ADMIN_AUTH_ENABLED=false`（免密模式）时，`enabled` 为 `false`，`authenticated` 直接允许管理接口访问。
  - 当 `ADMIN_AUTH_ENABLED=true` 时，未登录调用除 `/api/auth/session`、`/api/auth/login` 外的任何 `/api/*` 管理接口，统一返回 **`401 Unauthorized`**：
  ```json
  {"error":{"code":"admin_login_required","message":"Sign in to the console"}}
  ```
- **数据面 `/v1/*`**（如 `GET /v1/models`）：使用 `Authorization: Bearer <PROXY_API_KEY>` 鉴权，不走管理端 Cookie；无/错 Key 返回 **`401 Unauthorized`**：
  ```json
  {"error":{"message":"Invalid API Key","type":"invalid_request_error","param":null,"code":"invalid_api_key"}}
  ```

### 1.2 登录、会话与登出
- **登录 `POST /api/auth/login`**
  - 请求体：`{"username":"<ADMIN_USERNAME>","password":"<ADMIN_PASSWORD>"}`（对应 `.env` 中的 `ADMIN_USERNAME` / `ADMIN_PASSWORD`）
  - 响应：`200 OK`
    ```json
    {"authenticated":true,"enabled":true,"username":"magpie"}
    ```
  - 响应头 `Set-Cookie`：
    ```text
    aistudio_admin=<RANDOM_TOKEN>; Path=/api; Max-Age=43200; HttpOnly; SameSite=Strict
    ```
    > **关键属性**：`Path=/api`、`HttpOnly`、`SameSite=Strict`、`Max-Age=43200`（12 小时）。
- **会话状态 `GET /api/auth/session`**（携带 Cookie）
  - 响应：`200 OK`
    ```json
    {"authenticated":true,"enabled":true,"username":"magpie"}
    ```
- **登出 `POST /api/auth/logout`**
  - 响应：`204 No Content`
  - 响应头 `Set-Cookie`：
    ```text
    aistudio_admin=; Path=/api; Max-Age=0; HttpOnly; SameSite=Strict
    ```

### 1.3 Phase 2 Rust 反代鉴权桥接建议（`/aistudio-api`）
1. **Cookie Path 重写（最关键）**：上游 `Set-Cookie` 写死了 `Path=/api` 与 `SameSite=Strict`。若 Rust 网关将管理端挂载在 `/aistudio-api/*` 并反代到 `http://127.0.0.1:2048/api/*`，浏览器访问 `/aistudio-api/*` 时**不会携带 `Path=/api` 的 Cookie**。
   - **方案 A（推荐，最干净）**：Rust 网关在服务端持有/缓存 `aistudio_admin` Cookie（启动或首次请求时用读取到的 `ADMIN_USERNAME`/`ADMIN_PASSWORD` 自动登录 `POST /api/auth/login` 获取并在 401 时自动续期），由 8046 网关自身做统一鉴权，向上游透传服务端持有的 `Cookie: aistudio_admin=...`（对前端完全免二次登录）。
   - **方案 B（透传浏览器 Cookie）**：若需前端直传登录态，Rust 反代响应时必须将 `Set-Cookie` 中的 `Path=/api` 重写为 `Path=/aistudio-api`（或 `Path=/`）。

---

## 2. 核心管理 API 契约

### 2.1 服务健康 / 状态 / 控制
- **`GET /api/status`** -> `200 OK`
  ```json
  {
    "state": "RUNNING",
    "running": true,
    "ready": true,
    "version": "v0.3.13",
    "active_requests": 0,
    "accounts": { "total": 21, "ready": 8, "busy": 0, "cooldown": 0, "auth_required": 5 },
    "camoufox": { "ready": false, "preparing": false },
    "chrome_import": true,
    "time": "2026-11-22T01:03:34.6442048-08:00"
  }
  ```
  > 注：`/api/health` 返回 `404`，健康探活应使用 `/api/status`（登录后）或 `/api/auth/session`（免登录）。
- **`POST /api/control/start`**：启动生成服务。
- **`POST /api/control/stop`**：停止生成服务。
- **`GET /api/cooldowns`** -> `200 OK`：`{"cooldowns":[]}`
- **`GET /api/first-event-latency`** -> `200 OK`：`{"latencies":[]}`

### 2.2 账号管理与 SSE 事件流
- **`GET /api/accounts`** -> `200 OK`
  ```json
  {
    "accounts": [
      {
        "id": "user***@gmail.com",
        "label": "user***@gmail.com",
        "enabled": true,
        "state": "ready",
        "proxy": "",
        "egress": "http://127.0.0.1:7890",
        "locale": "en-US",
        "timezone": "America/Los_Angeles",
        "models": ["gemini-4-argon", "gemini-4-hydrogen", "gemini-4-neon", "..."],
        "benefit_tier": "Pro",
        "message": "",
        "active_requests": 0
      }
    ]
  }
  ```
- **账号操作端点**：
  - `POST /api/accounts`：创建新账号登录任务（返回 `{ task }`）。
  - `PUT /api/accounts/{id}`：更新账号字段（如 `label`、`proxy`）。
  - `PUT /api/accounts/{id}/state`：启用/禁用账号，请求体 `{"state":"enabled"}` / `{"state":"disabled"}`（或布尔控制）。
  - `DELETE /api/accounts/{id}`：删除账号。
  - `POST /api/accounts/{id}/login`：重新登录，请求体 `{"view": ...}`，返回 `{ task }`。
  - `POST /api/accounts/{id}/refresh`：刷新/测试账号状态与模型配额。
  - `DELETE /api/accounts/{id}/cooldowns/{model}`：清除指定模型冷却。
  - `GET /api/accounts/exits` -> `200 OK`：`{"exits":[{"proxy":"http://127.0.0.1:7890","ip":"198.65.x.x","country":"US","timezone":"America/Los_Angeles","locale":"en-US"}]}`
- **导入与登录任务**：
  - `GET /api/accounts/tasks` -> `200 OK`：`{"tasks":[]}`
    - 任务对象字段：`id: string`, `state: "pending" | "running" | "done" | "failed"`, `kind?: string`, `label?: string`, `account_id?: string`, `message?: string`, `error?: string`, `items?: Array<{ email?: string, label?: string, state?: string, error?: string }>`。
  - `DELETE /api/accounts/tasks/{id}`：取消/清理任务。
  - `POST /api/accounts/import/cookies/discover`：
    - 请求体：`{"cookies": "<cookie_string>", "proxy": ""}`
    - 响应：`{"accounts": [{"auth_user": 0, "email": "...", "restricted": ""}]}`
  - `POST /api/accounts/import/cookies`：
    - 请求体：`{"items": [{"email": "", "cookies": "<normalized_cookie>", "cdp": "", "auth_user": 0}], "proxy": "", "locale": "", "timezone": ""}`
    - 响应（异步受理）：`200/202 {"task": { "id": "...", "state": "pending" | "running", ... }}`
  - `GET /api/accounts/import/chrome` -> `200 OK`：
    - 响应：`{"profiles": [{"id": "Profile 1/...", "profile": "Profile 1", "display_name": "...", "email": "...", "restricted": ""}]}`
  - `POST /api/accounts/import/chrome`：
    - 请求体：`{"accounts": [{"id": "Profile 1/...", "email": "..."}], "proxy": "", "locale": "", "timezone": ""}`
    - 响应（异步受理）：`{"task": { "id": "...", "state": "pending" | "running", ... }}`
  - `GET /api/accounts/import/browsers?proxy=...`：扫描本机浏览器会话。
- **实时 SSE 事件流 `GET /api/events`** -> `200 OK` (`Content-Type: text/event-stream`)
  每条事件为标准 SSE `data: <JSON>\n\n`，已知 `type`：
  - `account_tasks`：`{"type":"account_tasks","data":{"tasks":[...]}}`
  - `status`：`{"type":"status","data":{...同 /api/status...}}`
  - `models`：`{"type":"models","data":{"models":[...]}}`
  - `accounts` / `cooldowns`：对应列表变更推送。
  - `log`：`{"type":"log","data":{"level":"INFO|WARN|ERROR","source":"...","event":"...","message":"...","fields":[{"key":"...","value":"..."}],"request":{"id":"..."},"stage":{"name":"...","step":0,"steps":0,"state":"..."}}}`（2048 原版前端在内存中保留最近 512 条，通过 `DELETE /api/logs` 清空）。
- **运行日志清理 `DELETE /api/logs`**：清空内存中的运行日志缓冲（注：`GET /api/logs` 实测返回 `405 Method Not Allowed`，实时日志仅通过 `/api/events` SSE `type="log"` 推送）。

### 2.3 API 密钥管理（重要架构发现）
- **实测结果**：`GET /api/keys`、`GET /api/api-keys`、`GET /api/apikeys`、`GET /api/tokens` 均返回 **`404 page not found`**。
- **真实机制**：`AIStudio2API` 原生不提供独立的 `/api/keys` CRUD 接口，而是通过 `GET /api/config` 与 `PUT /api/config` 读写：
  - `proxy_api_key`（对应 `.env` `PROXY_API_KEY`）：支持单个或多个逗号分隔的密钥。
  - `api_key_accounts`（对应 `.env` `API_KEY_ACCOUNTS`）：密钥到账号的绑定映射。
- **对 Phase 2 的提示**：若 8046 前端需要独立的多 API Key 列表/创建/吊销界面，应在 **8046 Rust 网关侧**实现 Key 表持久化（或由 Rust 同步写入 `PUT /api/config` 的 `proxy_api_key` / `api_key_accounts`）。

### 2.4 模型列表与配置开关
- **`GET /api/models`** -> `200 OK`
  ```json
  {
    "models": [
      {
        "id": "gemini-4-neon",
        "name": "Gemini 4 Neon",
        "description": "Gemini 4 Neon",
        "version": "3.0",
        "methods": ["generateContent", "countTokens", "batchGenerateContent"],
        "input_token_limit": 1048576,
        "output_token_limit": 65536,
        "temperature": 1,
        "max_temperature": 2,
        "top_p": 0.95,
        "top_k": 64,
        "thinking_levels": ["LOW", "MEDIUM", "HIGH", "EXTRA_HIGH"],
        "default_thinking_level": "HIGH",
        "tool_compatibility": [["google_search", "code_execution"]],
        "details": {
          "alias": "...",
          "summary": "...",
          "warning": "...",
          "docs_url": "...",
          "model_card_url": "...",
          "release_date": 1795035600,
          "knowledge_cutoff": 1790000000,
          "pricing": [{ "text": "..." }],
          "pricing_url": "..."
        },
        "capabilities": { "agentic_video": true, "browse": true, "output_continuation": true },
        "capability_options": { "aliases": ["..."] },
        "access_modes": [1, 3],
        "paid": true,
        "hidden": false,
        "channels": ["playground"]
      }
    ]
  }
  ```
  - **字段与前端展示规则（实测对齐 `AIStudio2API` 原版控制台）**：
    - **有效输出上限**：若 `capabilities.output_continuation === true`（如 `gemini-4-neon`、`gemini-4-argon`），原版控制台展示的有效输出上限取 `input_token_limit`（`1,048,576`），而非原始单次 `output_token_limit`（`65536` / `32768`）；其余模型取 `output_token_limit`（如 `gemini-3.8-flash` 为 `65,536`、`gemini-decision-1` 为 `1`）。数值统一以精确千分位展示，`0` 或缺失显示 `—`。
    - **通道（`channels`）**：`playground`（`Playground`）、`build`（`Build`）、`assistant`（`Build 对话`，含账号风控风险提示）。
    - **状态徽章**：`paid: true` 显示「付费」；`hidden: true` 或 `methods` 包含 `createDecision` 显示「官网隐藏」；`channels` 包含 `assistant` 显示「风控风险」。
    - **价格（`details.pricing`）**：常规模型返回 `[{ "text": "..." }]`，部分模型（如 `gemini-decision-1`）返回 `[{ "input": 0.1 }]`。
- **模型配置/别名开关**：通过 `PUT /api/config` 修改以下字段实现：
  `model_mapping`、`model_channels`、`model_accounts`、`search_model_aliases`、`discover_hidden_models`、`upstream_channels`、`google_search`。

### 2.5 在途请求与历史请求
- **`GET /api/requests`** -> `200 OK`：`{"requests":[]}`（当前在途请求列表）
- **`POST /api/requests/{id}/cancel`**：取消指定在途请求。
- **`GET /api/requests/{id}/body`**：查看请求体详情（需开启 `request_body_log`）。

### 2.6 用量统计（汇总 / 图表 / 明细 / CSV 导出）
> 注意：`from` 与 `to` 查询参数**必填**，且必须为 **RFC 3339** 格式（否则返回 `400 {"error":{"code":"invalid_request","message":"from 必须是 RFC 3339 时间"}}`）。
- **`GET /api/usage?from=...&to=...`** -> `200 OK`
  返回字段：`from`, `to`, `bucket_seconds`, `generated_at`, `latest_at`, `totals`（含 `requests`, `succeeded`, `failed`, `canceled`, `rate_limited`, `input_tokens`, `cached_tokens`, `reasoning_tokens`, `reply_tokens`, `total_tokens`, `duration.{avg_ms,p50_ms,p95_ms,p99_ms}`, `first_event.{...}`, `queue_avg_ms`）, `previous`, `cost`, `previous_cost`, `unpriced_models`, `recent`, `buckets[]`。
- **`GET /api/usage/pairs?from=...&to=...`** -> `200 OK`
  返回 `{"pairs": [{ "account", "model", "requests", "succeeded", "failed", "canceled", "rate_limited", "input_tokens", "cached_tokens", "reasoning_tokens", "reply_tokens", "total_tokens", "duration", "first_event", "queue_avg_ms", "last_at" }]}`。
- **`GET /api/usage/records?from=...&to=...&limit=...`** -> `200 OK`
  返回 `{"items": [{ "id", "time", "protocol", "path", "model", "account", "channel", "status", "state", "duration_ms", "first_event_ms", "queue_ms", "proof_ms", "proof_phases": { "lock_ms", "interaction_ms", "refresh_ms", "compute_ms" }, "input_tokens", "cached_tokens", "reasoning_tokens", "reply_tokens", "total_tokens", "tool_calls", "error", "attempts": [{ "account", "channel", "error", "duration_ms" }], "has_body": boolean }], "next_cursor": "..."}`。
- **`GET /api/usage/records.csv?from=...&to=...`** -> `200 OK` (`text/csv; charset=utf-8`)
  表头：`time,id,protocol,path,model,account,channel,status,state,duration_ms,first_event_ms,queue_ms,input_tokens,cached_tokens,reasoning_tokens,reply_tokens,total_tokens,tool_calls,error,attempts,proof_ms,proof_lock_ms,proof_interaction_ms,proof_refresh_ms,proof_compute_ms`

### 2.7 运行配置（`.env` 字段映射）
- **`GET /api/config`** -> `200 OK` / **`PUT /api/config`**（保存配置）
- 实测完整返回字段：
  - 基础与服务：`auto_start`, `hide_dock_icon`, `request_body_log`, `admin_auth_enabled`, `admin_username`, `admin_password_set`, `auth_states`, `listen_addr`, `active_listen_addr`, `reserved_listen_addr`, `preview_listen_addr`, `active_preview_listen_addr`, `proxy_api_key`, `active_proxy_api_key`, `management_restart_required`, `service_restart_required`, `log_file`, `log_max_total_mb`, `environment[]`, `invalid[]`
  - 代理与池：`proxy`, `active_proxy`, `proxy_pool[]` (`{proxy, available, accounts}`)
  - 协议与行为：`build_native_nonstream`, `nonstream_keepalive`, `fake_stream`, `youtube_links`, `strip_thought_signatures`, `search_model_aliases`, `discover_hidden_models`, `google_search`, `first_event_hedge`, `first_event_hedge_models`, `continuation_rewrite`, `continuation_prompt`, `waa_backend`, `media_output`, `media_base_url`
  - 并发与路由：`init_timeout`, `request_timeout`, `warm_worker_limit`, `max_active_workers`, `warm_startup_concurrency`, `per_account_concurrency`, `routing_strategy`, `account_order`, `max_account_switches`, `upstream_channels[]`, `model_mapping`, `model_channels`, `model_accounts`, `api_key_accounts`

### 2.8 版本检查与更新
- **`GET /api/update`**（强制刷新：`GET /api/update?refresh=1`）-> `200 OK`
  ```json
  {
    "current": "v0.3.13",
    "latest": "v0.3.13",
    "available": false,
    "mode": "binary",
    "notes": "..."
  }
  ```
- **`POST /api/update`**：触发应用更新。

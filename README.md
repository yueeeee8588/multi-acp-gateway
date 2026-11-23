# 多功能 ACP 聚合网关（Multi-ACP Gateway）

基于 **Rust（Axum + SQLite + WebView2 桌面壳）+ React** 构建的多协议 AI 模型聚合网关与 **Gemini 三入口通用反代理一体化平台**。

项目采用 **1 主网关 + 3 路 Gemini 反代理** 的四服务架构，支持 **Windows 独立桌面客户端（`gateway-tray.exe`）**、命令行直跑以及 **Docker Compose** 部署。

---

## 一、四服务整体架构

在 Windows 桌面端模式下，由 `gateway-tray.exe` 统一托管全部子服务（Windows Job Object 防僵尸 + 3 秒健康探针 + 指数退避重启 + 系统托盘常驻 + 独立 WebView2 窗口免密登录）：

| 服务 | 默认端口 | 技术栈 / 目录 | 8046 控制台集成 | 定位与职责 |
| --- | --- | --- | --- | --- |
| **8046 主网关** | `127.0.0.1:8046` | Rust (`src/`) + 内嵌 React (`web/`) | 根入口 | 多协议聚合与互转、多上游池化调度、自定义提示词与过滤管线、密钥与分组权限、内置聊天与统一控制台 |
| **8048 ACP 网关** | `127.0.0.1:8048` | Bun (`acp-gateway-8048/`) | `/acp-api/*`（「ACP 控制台」页） | 基于 ACP worker 与 Loopback MCP 的原生 Gemini `/v1beta` 多账号轮询反代理 |
| **8049 Gemini App2API** | `127.0.0.1:8049` | Node.js >= 22 (`gemini-app2api-8049/`) | 托盘统一托管 + 独立 `/admin/` | 基于零依赖原生 HTTP/2 的 Gemini 订阅账号反代理，提供多账号池化与 OpenAI 兼容 `/v1` 入口 |
| **2048 AI Studio** | `127.0.0.1:2048` | Node.js (`magpie-aistudio-2048/`) | `/aistudio-api/*`（「AI Studio」页） | 基于 Google AI Studio（AIStudio2API）的反代理入口，支持原生 Function Calling、多思考档位与图像生成模型 |

> **三路 Gemini 反代理的两种用法**：
> 1. **作为独立通用反代理直连**：客户端可直接连接 `8048`（Gemini `/v1beta`）、`8049`（OpenAI `/v1/chat/completions` & `/v1/responses`）或 `2048`（AI Studio 兼容接口）。
> 2. **汇聚至 8046 主网关统一调度**：在 8046「账号管理」中将任意一路或多路反代理（以及第三方 OpenAI / Anthropic / Gemini 上游）添加为上游账号，统一享有跨协议互转、密钥隔离、失败冷却、粘性会话与自定义提示词/风控能力。

---

## 二、核心能力

1. **多协议接入与互转**
   - OpenAI Responses：`/v1/responses`、`/v1/responses/compact`
   - OpenAI Chat Completions：`/v1/chat/completions`
   - Anthropic Messages：`/v1/messages`
   - Gemini 原生协议：`/v1beta/models`、`/v1beta/models/{*rest}`
   - 统一模型发现与列表：`/v1/models`、`/v1beta/models`

2. **多上游池化与高可用调度**
   - **分组 / 账号 / 密钥三层权限模型**：支持按分组绑定上游账号，按客户端 API Key 分配分组与策略开关。
   - **模型映射与优先级**：支持每账号独立的 `model_mappings`、优先级排序、RPM 与并发限制、粘性会话。
   - **独立代理与连通性测试**：支持按账号单独配置加密存储的 SOCKS5 / SOCKS5h 代理，并提供控制台一键连通性测试。
   - **故障转移与冷却**：按分组、协议与目标模型维度计算账号冷却，全部冷却时自动重置池状态继续轮询，流式响应开始转发后不重放。

3. **自定义提示词与过滤管线**
   - 支持全局系统提示词（`global_prompt`）、自定义模板槽位（`custom_template_prompts`）与敏感词过滤规则（默认均为空，按需开启）。

4. **统一控制台与静态加密存储**
   - 前端构建后通过 `rust-embed` 直接内嵌进主二进制，包含「聊天（Playground）」「仪表盘与请求日志（支持导出）」「密钥 / 分组 / 账号 / 服务提供商」「提示词与风控」「ACP 控制台」「AI Studio」「系统设置」等模块。
   - 上游凭证、客户端密钥与代理配置使用 **AES-GCM + Argon2** 加密存储于 SQLite；支持自定义安全访问路径与可选 Cloudflare Turnstile 登录人机校验。
   - 桌面端用户数据统一隔离在 `%LOCALAPPDATA%\MultiAcpGateway\data\`（下分 `8046/`、`8048/`、`8049/`、`2048/`、`logs/`）。

---

## 三、目录结构

```text
.
├── src/                    # 8046 主网关 (multi-acp-gateway) 与桌面托盘壳 (gateway-tray)
│   ├── bin/gateway-tray.rs # Windows 独立桌面客户端入口 (tao + wry WebView2)
│   ├── tray/               # 四服务看门狗、Job Object、托盘菜单、桌面免密态与自启管理
│   ├── proxy/ & proxy.rs   # 多协议代理转发、互转、轮询与故障转移
│   ├── acp_proxy.rs        # /acp-api/*、/aistudio-api/* 控制台反向代理
│   └── ...                 # API、SQLite 加密存储、Playground、Providers、在线更新等
├── web/                    # React + TypeScript 统一前端控制台
│   └── src/
│       ├── acp/            # 8048 ACP 控制台页面
│       └── aistudio/       # 2048 AI Studio 控制台页面
├── acp-gateway-8048/       # 8048 ACP 伴生网关（Bun）
├── gemini-app2api-8049/    # 8049 Gemini App 反代理后端（Node.js >= 22）
├── magpie-aistudio-2048/   # 2048 Google AI Studio 反代理后端（Node.js）
├── installer/              # Windows Inno Setup 安装包配置 (setup.iss, app.ico)
├── scripts/                # 桌面端打包 (stage-windows-bundle.ps1) 与安全扫描脚本
├── Cargo.toml              # Rust 工程配置（multi-acp-gateway + gateway-tray）
├── Dockerfile              # 容器镜像构建定义
└── compose.yaml            # Docker Compose 编排（含 updater 伴生服务）
```

---

## 四、快速启动与构建

### 1. 本地源码构建与运行

```bash
# 1. 复制环境变量模板（按需调整）
cp .env.example .env

# 2. 构建 React 前端（产物位于 web/dist，编译 Rust 时自动内嵌）
cd web && npm ci && npm run build && cd ..

# 3. 运行测试并启动 8046 主网关
cargo test --lib
cargo test --bin gateway-tray
cargo run --release
```

### 2. Windows 独立桌面客户端打包

```powershell
# 编译 Release 并组装四服务运行环境
cargo build --release
powershell -ExecutionPolicy Bypass -File scripts/stage-windows-bundle.ps1 -Profile public -SkipBuild

# 使用 Inno Setup 编译安装器
ISCC.exe installer\setup.iss
```

### 3. Docker Compose 部署

```bash
cp .env.example .env
docker compose up -d --build
```

---

## 五、常用环境变量

| 变量名 | 默认值 | 说明 |
| --- | --- | --- |
| `BIND_ADDR` | `127.0.0.1:8046` | 8046 主网关监听地址 |
| `DATA_DIR` | `data`（桌面端优先取 `APP_DATA_DIR/8046`） | SQLite 数据库与加密密钥目录 |
| `APP_DATA_DIR` | `%LOCALAPPDATA%\MultiAcpGateway\data` | 桌面端四服务统一用户数据根目录 |
| `WEB_DIR` | 空（默认使用二进制内嵌 `web/dist`） | 指定外部静态前端目录以覆盖内嵌资源 |
| `ACP_UPSTREAM_BASE` | `http://127.0.0.1:8048` | 8048 ACP 伴生服务地址 |
| `AISTUDIO_UPSTREAM_BASE` | `http://127.0.0.1:2048` | 2048 AI Studio 伴生服务地址 |
| `GATEWAY_8046_PORT` / `GATEWAY_8049_PORT` | `8046` / `8049` | 桌面端覆盖 8046 / 8049 监听端口 |
| `GATEWAY_DISABLE_8048` | `false` | 设为 `1`/`true` 时桌面端跳过托管 8048 服务 |
| `RUST_LOG` | `multi_acp_gateway=info` | 日志级别过滤 |
| `UPDATER_REPO` / `GITHUB_TOKEN` | `yueeeee8588/multi-acp-gateway` / 空 | 源码在线更新仓库与可选 GitHub Token |

---

## 六、GitHub 源码在线更新

- **本地直跑模式**：可在控制台「系统更新」页点击「检查更新」，直接从 GitHub 拉取最新正式版（`releases/latest`）与更新日志。
- **Docker Compose 模式**：执行 `docker compose up -d` 会自动启用 `updater` 伴生服务（`gateway-sync`），在控制台「系统更新」页验证管理员密码后，即可一键完成「获取源码 → 构建镜像 → 部署版本 → 健康验证（失败自动回滚）」。
- **切换更新源与令牌**：如果 Fork 了本仓库，可在 `.env` 中通过 `UPDATER_REPO=owner/repo` 切换更新源；如需避免 GitHub API 未认证请求触发速率限制，也可在 `.env` 中补充 `GITHUB_TOKEN`。

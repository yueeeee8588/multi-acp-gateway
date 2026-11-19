# 多功能 ACP 聚合网关

基于 **Rust (Axum + SQLite) + React** 构建的多协议 AI 模型聚合与 ACP 调度网关，配合 `acp-gateway-8048/` 伴生服务实现多上游池化、协议互转与统一控制台管理。

## 核心架构

- **主网关（8046，Rust + React）**：负责客户端接入、OpenAI Responses / Chat Completions / Anthropic Messages / Gemini 原生协议互转、多上游账号轮询与冷却、请求日志与密钥策略管理，以及 `web/` 前端控制台静态托管。
- **ACP 伴生网关（`acp-gateway-8048/`，Bun/Node）**：作为 8046 的上游适配器，通过 `ACP_UPSTREAM_BASE=http://127.0.0.1:8048` 接入统一凭证与本地推理通道。

## 主要特性

- **多协议互转与透传**：支持 `/v1/responses`、`/v1/responses/compact`、`/v1/chat/completions`、`/v1/messages` 及 `/v1beta/models/*` 等接口。
- **多上游池化与故障转移**：支持账号优先级、并发限制、失败冷却、粘性会话与上游超时控制。
- **自定义提示词与过滤管线**：支持全局系统提示词（`global_prompt`）、自定义模板槽位（`custom_template_prompts`）与敏感词过滤规则（默认均为空，按需开启）。
- **静态加密存储**：上游凭证与敏感配置使用 AES-GCM 与 Argon2 加密存储于 `DATA_DIR`。

## 快速启动

1. 复制 `.env.example` 为 `.env`，按需修改监听地址与 `ACP_UPSTREAM_BASE`。
2. 构建前端资源：
   ```bash
   cd web && npm ci && npm run build
   ```
3. 启动主网关：
   ```bash
   cargo run --release
   ```
4. 如需使用 Docker Compose 部署，可直接运行：
   ```bash
   docker compose up -d --build
   ```

## 配置说明

| 变量名 | 默认值 | 说明 |
| --- | --- | --- |
| `BIND_ADDR` | `127.0.0.1:8046` | 主网关监听地址 |
| `DATA_DIR` | `data` | SQLite 数据库与加密密钥目录 |
| `WEB_DIR` | `web/dist` | 前端构建产物目录 |
| `ACP_UPSTREAM_BASE` | `http://127.0.0.1:8048` | ACP 伴生服务地址 |
| `RUST_LOG` | `multi_acp_gateway=info` | 日志级别过滤 |

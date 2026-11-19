# acp-gateway-8048

多功能 ACP 聚合网关 - 8048 ACP 伴生服务。

基于 `agy acp --worker` 与 `LoopbackMcpServer` 的多协议（Gemini `/v1beta`、OpenAI `/v1/chat/completions`、Anthropic `/v1/messages`）ACP 多账号轮询伴生网关（默认监听 `127.0.0.1:8048`），提供 Worker 池管理、账号配额/健康探测及 `/api/*` 管理接口。

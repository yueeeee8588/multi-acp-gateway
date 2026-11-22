export type AiStudioAuthMode = "managed" | "manual";

export interface AiStudioAuthSession {
  authenticated: boolean;
  enabled: boolean;
  username: string;
  mode?: AiStudioAuthMode;
}

export interface AiStudioStatus {
  state: string;
  running: boolean;
  ready: boolean;
  version: string;
  active_requests: number;
  accounts: {
    total: number;
    ready: number;
    busy: number;
    cooldown: number;
    auth_required: number;
  };
  camoufox?: {
    ready: boolean;
    preparing: boolean;
  };
  chrome_import?: boolean;
  time: string;
}

export interface AiStudioAccount {
  id: string;
  label: string;
  enabled: boolean;
  state: string;
  proxy: string;
  egress: string;
  locale?: string;
  timezone?: string;
  models?: string[];
  benefit_tier?: string;
  message?: string;
  active_requests?: number;
  cooldown_until?: string;
}

export interface AiStudioAccountExit {
  proxy: string;
  ip: string;
  country: string;
  timezone: string;
  locale: string;
}

export interface AiStudioAccountTaskItem {
  email?: string;
  label?: string;
  state?: string;
  error?: string;
}

export interface AiStudioAccountTask {
  id: string;
  kind?: string;
  type?: string;
  state?: string;
  status?: string;
  account_id?: string;
  label?: string;
  message?: string;
  error?: string;
  items?: AiStudioAccountTaskItem[];
  created_at?: string;
  updated_at?: string;
  view_url?: string;
}

export interface AiStudioChromeProfile {
  id: string;
  profile: string;
  display_name: string;
  email: string;
  restricted: string;
}

export interface AiStudioDiscoveredCookieAccount {
  auth_user: number;
  email: string;
  restricted?: string;
}

export interface AiStudioBrowserProfileAccount {
  id?: string;
  email?: string;
  name?: string;
  label?: string;
  browser?: string;
  profile?: string;
  profile_dir?: string;
  user_data_dir?: string;
  [key: string]: unknown;
}

export interface AiStudioBrowserInfo {
  id?: string;
  name?: string;
  browser?: string;
  profile?: string;
  profiles?: AiStudioBrowserProfileAccount[];
  accounts?: AiStudioBrowserProfileAccount[];
  [key: string]: unknown;
}

export interface AiStudioImportCookiesItem {
  email?: string;
  cookies: string;
  cdp?: string;
  auth_user?: number;
}

export interface AiStudioImportCookiesPayload {
  items: AiStudioImportCookiesItem[];
  proxy?: string;
  locale?: string;
  timezone?: string;
}

export interface AiStudioImportChromePayload {
  accounts: AiStudioBrowserProfileAccount[];
  proxy?: string;
}

export interface AiStudioModel {
  id: string;
  name: string;
  description?: string;
  version?: string;
  methods?: string[];
  input_token_limit?: number;
  output_token_limit?: number;
  temperature?: number;
  max_temperature?: number;
  top_p?: number;
  top_k?: number;
  thinking_levels?: string[];
  default_thinking_level?: string;
  tool_compatibility?: string[][];
  details?: {
    alias?: string;
    summary?: string;
    warning?: string;
    docs_url?: string;
    model_card_url?: string;
    release_date?: number;
    knowledge_cutoff?: number;
    pricing?: Array<{
      text?: string;
      input?: number;
      output?: number;
      [key: string]: unknown;
    }>;
    pricing_url?: string;
  };
  capabilities?: Record<string, boolean>;
  capability_options?: Record<string, string[]>;
  access_modes?: number[];
  paid?: boolean;
  hidden?: boolean;
  channels?: string[];
}

export interface AiStudioActiveRequest {
  id: string;
  method?: string;
  path?: string;
  model?: string;
  account?: string;
  channel?: string;
  state?: string;
  started_at?: string;
  duration_ms?: number;
}

export interface AiStudioCooldown {
  account: string;
  model: string;
  until?: string;
  reason?: string;
}

export interface AiStudioLatencyStats {
  avg_ms: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
}

export interface AiStudioUsageBucket {
  at: string;
  cost: number;
  requests: number;
  succeeded: number;
  failed: number;
  canceled: number;
  rate_limited: number;
  input_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
  reply_tokens: number;
  total_tokens: number;
  duration: AiStudioLatencyStats;
  first_event: AiStudioLatencyStats;
  queue_avg_ms: number;
}

export interface AiStudioUsageSummary {
  from: string;
  to: string;
  bucket_seconds: number;
  generated_at: string;
  latest_at?: string;
  totals: {
    requests: number;
    succeeded: number;
    failed: number;
    canceled: number;
    rate_limited: number;
    input_tokens: number;
    cached_tokens: number;
    reasoning_tokens: number;
    reply_tokens: number;
    total_tokens: number;
    duration: AiStudioLatencyStats;
    first_event: AiStudioLatencyStats;
    queue_avg_ms: number;
  };
  previous?: {
    requests: number;
    succeeded: number;
    total_tokens: number;
  };
  cost: number;
  previous_cost?: number;
  unpriced_models?: string[];
  recent?: {
    minutes: number;
    requests: number;
    tokens: number;
  };
  buckets: AiStudioUsageBucket[];
}

export interface AiStudioUsagePair {
  account: string;
  model: string;
  requests: number;
  succeeded: number;
  failed: number;
  canceled: number;
  rate_limited: number;
  input_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
  reply_tokens: number;
  total_tokens: number;
  duration: AiStudioLatencyStats;
  first_event: AiStudioLatencyStats;
  queue_avg_ms: number;
  last_at?: string;
}

export interface AiStudioProofPhases {
  lock_ms: number;
  interaction_ms: number;
  refresh_ms: number;
  compute_ms: number;
}

export interface AiStudioUsageAttempt {
  account?: string;
  channel?: string;
  error?: string;
  duration_ms?: number;
  [key: string]: unknown;
}

export interface AiStudioUsageRecord {
  id: string;
  time: string;
  protocol: string;
  path: string;
  model: string;
  account: string;
  channel: string;
  status: number;
  state: string;
  duration_ms: number;
  first_event_ms: number;
  queue_ms: number;
  proof_ms?: number;
  proof_phases?: AiStudioProofPhases;
  input_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
  reply_tokens: number;
  total_tokens: number;
  tool_calls: number;
  error?: string;
  attempts?: AiStudioUsageAttempt[];
  has_body?: boolean;
}

export interface AiStudioLogField {
  key: string;
  value: string;
}

export interface AiStudioLogEntry {
  id?: string;
  time?: string;
  timestamp?: string;
  level?: string;
  source?: string;
  event?: string;
  message?: string;
  fields?: AiStudioLogField[];
  request?: { id?: string; [key: string]: unknown };
  stage?: { name?: string; step?: number; steps?: number; state?: string };
  [key: string]: unknown;
}

export interface AiStudioProxyPoolItem {
  proxy: string;
  available: boolean;
  accounts: number;
}

export interface AiStudioConfig {
  auto_start: boolean;
  hide_dock_icon: boolean;
  request_body_log: boolean;
  admin_auth_enabled: boolean;
  admin_username: string;
  admin_password?: string;
  admin_password_set?: boolean;
  build_native_nonstream: boolean;
  nonstream_keepalive: boolean;
  fake_stream: boolean;
  youtube_links: boolean;
  strip_thought_signatures: boolean;
  search_model_aliases: boolean;
  discover_hidden_models: boolean;
  google_search: boolean;
  first_event_hedge: string;
  first_event_hedge_models: string;
  continuation_rewrite: boolean;
  continuation_prompt: string;
  log_file: boolean;
  log_max_total_mb: number;
  auth_states?: string;
  listen_addr: string;
  proxy_api_key: string;
  active_listen_addr?: string;
  reserved_listen_addr?: string;
  preview_listen_addr: string;
  active_preview_listen_addr?: string;
  active_proxy_api_key?: string;
  management_restart_required?: boolean;
  service_restart_required?: boolean;
  proxy: string;
  active_proxy?: string;
  proxy_pool?: AiStudioProxyPoolItem[];
  init_timeout: string;
  request_timeout: string;
  warm_worker_limit: number;
  max_active_workers: number;
  warm_startup_concurrency: number;
  per_account_concurrency: number;
  routing_strategy: string;
  account_order: string;
  max_account_switches: number;
  upstream_channels?: string[];
  model_mapping: string;
  model_channels: string;
  model_accounts: string;
  api_key_accounts: string;
  waa_backend: string;
  media_output: string;
  media_base_url: string;
  environment?: string[];
  invalid?: string[];
}

export type AiStudioConfigPatch = Partial<AiStudioConfig> & {
  admin_password?: string;
};

export interface AiStudioUpdateInfo {
  current: string;
  latest: string;
  available: boolean;
  mode: string;
  notes: string;
}

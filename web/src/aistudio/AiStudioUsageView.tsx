import { useCallback, useEffect, useState } from "react";
import { Activity, Coins, Cpu, Download, Gauge, RefreshCw } from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Badge, Button, Empty, ErrorBox } from "../components";
import type { Notice } from "../components";
import {
  downloadUsageCsv,
  fetchUsage,
  fetchUsagePairs,
  fetchUsageRecords,
} from "./api";
import type {
  AiStudioUsagePair,
  AiStudioUsageRecord,
  AiStudioUsageSummary,
} from "./types";

type RangePreset = "24h" | "7d" | "30d";

function buildWindow(preset: RangePreset): { from: string; to: string } {
  const now = new Date();
  const hours = preset === "24h" ? 24 : preset === "7d" ? 24 * 7 : 24 * 30;
  const from = new Date(now.getTime() - hours * 3600 * 1000);
  return { from: from.toISOString(), to: now.toISOString() };
}

function fmtNum(n: number | undefined): string {
  return (n ?? 0).toLocaleString();
}

export function AiStudioUsageView({ notify }: { notify: Notice }) {
  const [range, setRange] = useState<RangePreset>("24h");
  const [windowRange, setWindowRange] = useState(() => buildWindow("24h"));
  const [summary, setSummary] = useState<AiStudioUsageSummary | null>(null);
  const [pairs, setPairs] = useState<AiStudioUsagePair[]>([]);
  const [records, setRecords] = useState<AiStudioUsageRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");

  const loadUsage = useCallback(
    async (preset: RangePreset) => {
      const nextWin = buildWindow(preset);
      setWindowRange(nextWin);
      setLoading(true);
      setError("");
      try {
        const [u, p, r] = await Promise.all([
          fetchUsage(nextWin.from, nextWin.to),
          fetchUsagePairs(nextWin.from, nextWin.to),
          fetchUsageRecords(nextWin.from, nextWin.to, 50),
        ]);
        setSummary(u);
        setPairs(p);
        setRecords(r);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        notify(msg, true);
      } finally {
        setLoading(false);
      }
    },
    [notify],
  );

  useEffect(() => {
    void loadUsage(range);
  }, [range, loadUsage]);

  async function handleExportCsv() {
    setExporting(true);
    setError("");
    try {
      await downloadUsageCsv(windowRange.from, windowRange.to);
      notify("已导出用量明细 CSV");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      notify(msg, true);
    } finally {
      setExporting(false);
    }
  }

  const totals = summary?.totals;
  const successRate =
    totals && totals.requests > 0
      ? `${((totals.succeeded / totals.requests) * 100).toFixed(1)}%`
      : "-";

  const chartData = (summary?.buckets ?? []).map((b) => ({
    label: b.at.slice(5, 16).replace("T", " "),
    requests: b.requests,
    tokens: Math.round(b.total_tokens / 1000),
  }));

  return (
    <div style={{ display: "grid", gap: 18 }}>
      <div className="page-heading" style={{ flexWrap: "wrap" }}>
        <div>
          <div className="eyebrow">AI STUDIO · 用量与账单</div>
          <h1>用量与成本统计</h1>
          <p>支持 24 小时 / 7 天 / 30 天 RFC 3339 窗口聚合、延迟分布与 CSV 明细导出</p>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <div className="segmented" role="tablist" aria-label="统计时间范围">
            {(["24h", "7d", "30d"] as const).map((preset) => (
              <button
                key={preset}
                type="button"
                role="tab"
                aria-selected={range === preset}
                className={range === preset ? "selected" : ""}
                onClick={() => setRange(preset)}
              >
                {preset === "24h" ? "近 24 小时" : preset === "7d" ? "近 7 天" : "近 30 天"}
              </button>
            ))}
          </div>
          <Button type="button" busy={loading} onClick={() => void loadUsage(range)}>
            <RefreshCw size={14} />
            刷新
          </Button>
          <Button
            type="button"
            className="primary"
            busy={exporting}
            onClick={() => void handleExportCsv()}
          >
            <Download size={14} />
            导出 CSV
          </Button>
        </div>
      </div>

      <ErrorBox message={error} />

      <div className="aistudio-metrics-row">
        <div className="aistudio-metric-card">
          <div className="metric-top">
            <span>总请求数 / 成功率</span>
            <span className="metric-icon">
              <Activity size={16} />
            </span>
          </div>
          <div className="metric-value">{fmtNum(totals?.requests)}</div>
          <div className="metric-bottom">
            成功率 {successRate} · 失败 {fmtNum(totals?.failed)} · 取消 {fmtNum(totals?.canceled)}
          </div>
        </div>

        <div className="aistudio-metric-card">
          <div className="metric-top">
            <span>总 Token 消耗</span>
            <span className="metric-icon">
              <Cpu size={16} />
            </span>
          </div>
          <div className="metric-value">{fmtNum(totals?.total_tokens)}</div>
          <div className="metric-bottom">
            输入 {fmtNum(totals?.input_tokens)} · 输出 {fmtNum(totals?.reply_tokens)}
          </div>
        </div>

        <div className="aistudio-metric-card">
          <div className="metric-top">
            <span>缓存 / 推理 Token</span>
            <span className="metric-icon">
              <Cpu size={16} />
            </span>
          </div>
          <div className="metric-value">{fmtNum(totals?.cached_tokens)}</div>
          <div className="metric-bottom">
            推理 (Reasoning) {fmtNum(totals?.reasoning_tokens)}
          </div>
        </div>

        <div className="aistudio-metric-card">
          <div className="metric-top">
            <span>耗时 P50 / P95</span>
            <span className="metric-icon">
              <Gauge size={16} />
            </span>
          </div>
          <div className="metric-value">
            {totals ? `${Math.round(totals.duration.p50_ms)} ms` : "-"}
          </div>
          <div className="metric-bottom">
            P95 {totals ? `${Math.round(totals.duration.p95_ms)} ms` : "-"} · 首字 P50{" "}
            {totals ? `${Math.round(totals.first_event.p50_ms)} ms` : "-"}
          </div>
        </div>

        <div className="aistudio-metric-card">
          <div className="metric-top">
            <span>预估参考成本</span>
            <span className="metric-icon">
              <Coins size={16} />
            </span>
          </div>
          <div className="metric-value">${(summary?.cost ?? 0).toFixed(4)}</div>
          <div className="metric-bottom">
            上周期 ${(summary?.previous_cost ?? 0).toFixed(4)}
          </div>
        </div>
      </div>

      {chartData.length > 0 && (
        <section className="data-section">
          <div className="list-toolbar">
            <div style={{ fontWeight: 700, fontSize: 14 }}>请求趋势分桶</div>
            <div className="toolbar-meta">
              <span>分桶间隔 {summary?.bucket_seconds ?? 3600}s</span>
            </div>
          </div>
          <div className="aistudio-chart-box">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: "var(--muted)" }} />
                <YAxis tick={{ fontSize: 11, fill: "var(--muted)" }} />
                <Tooltip />
                <Area
                  type="monotone"
                  dataKey="requests"
                  name="请求数"
                  stroke="var(--pink-500)"
                  fill="var(--pink-500)"
                  fillOpacity={0.16}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </section>
      )}

      <section className="data-section">
        <div className="list-toolbar">
          <div style={{ fontWeight: 700, fontSize: 14 }}>
            账号 - 模型分布 ({pairs.length})
          </div>
          <div className="toolbar-meta">
            <span>按账号与模型维度聚合的请求量、成功率与延迟</span>
          </div>
        </div>
        {pairs.length === 0 ? (
          <Empty
            title="当前时间窗口无分布数据"
            detail="尝试切换到近 7 天或近 30 天查看历史统计。"
          />
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="acp-accounts-table">
              <thead>
                <tr>
                  <th>账号</th>
                  <th>模型</th>
                  <th>请求 (成功/失败)</th>
                  <th>总 Token</th>
                  <th>P50 耗时</th>
                </tr>
              </thead>
              <tbody>
                {pairs.map((p, idx) => (
                  <tr key={`${p.account}-${p.model}-${idx}`}>
                    <td>{p.account}</td>
                    <td className="mono">{p.model}</td>
                    <td>
                      {p.requests} ({p.succeeded}/{p.failed})
                    </td>
                    <td className="mono">{fmtNum(p.total_tokens)}</td>
                    <td className="mono">{Math.round(p.duration.p50_ms)} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="table-footer">
          <span>分布组合：{pairs.length}</span>
        </div>
      </section>

      <section className="data-section">
        <div className="list-toolbar">
          <div style={{ fontWeight: 700, fontSize: 14 }}>
            最近请求明细 ({records.length})
          </div>
          <div className="toolbar-meta">
            <span>单次请求的协议、状态码、首字延迟与错误信息</span>
          </div>
        </div>
        {records.length === 0 ? (
          <Empty
            title="当前时间窗口无请求明细"
            detail="发起请求后将在此记录每次调用的详细轨迹。"
          />
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="acp-accounts-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>模型</th>
                  <th>账号</th>
                  <th>状态</th>
                  <th>耗时 / 首字</th>
                  <th>Token</th>
                </tr>
              </thead>
              <tbody>
                {records.map((rec) => (
                  <tr key={rec.id}>
                    <td className="mono">{rec.time.slice(0, 19).replace("T", " ")}</td>
                    <td className="mono">{rec.model}</td>
                    <td>{rec.account || "-"}</td>
                    <td>
                      <Badge
                        variant={
                          rec.status >= 200 && rec.status < 300
                            ? "green"
                            : rec.status === 499
                              ? "amber"
                              : "red"
                        }
                      >
                        {rec.status} {rec.state}
                      </Badge>
                    </td>
                    <td className="mono">
                      {rec.duration_ms}ms / {rec.first_event_ms}ms
                    </td>
                    <td className="mono">{fmtNum(rec.total_tokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="table-footer">
          <span>明细条数：{records.length}</span>
          <span>最多显示最近 50 条</span>
        </div>
      </section>
    </div>
  );
}

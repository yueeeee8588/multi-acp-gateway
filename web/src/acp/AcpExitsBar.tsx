import { AlertTriangle, Globe } from "lucide-react";
import type { ExitGroup } from "./types";

export interface AcpExitsBarProps {
  exits: ExitGroup[];
  selectedIp?: string;
  onSelect: (ip: string) => void;
}

export function AcpExitsBar({
  exits,
  selectedIp = "",
  onSelect,
}: AcpExitsBarProps) {
  const realExits = exits.filter(
    (g) => Boolean(g.ip && g.ip.trim().toLowerCase() !== "unknown")
  );
  if (realExits.length === 0) {
    return null;
  }

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "8px",
        marginBottom: "18px",
        padding: "12px 16px",
        borderRadius: "var(--radius-lg)",
        border: "1.5px solid #fff",
        background: "var(--surface)",
        boxShadow: "var(--shadow-sm)",
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          fontSize: "12px",
          fontWeight: 700,
          color: "var(--muted)",
          marginRight: "4px",
        }}
      >
        <Globe size={14} />
        出口 IP:
      </span>

      {realExits.map((exit) => {
        const exitKey = exit.ip.trim();
        const isSelected = selectedIp === exitKey;
        const isWarning = exit.sharedWarning;
        const displayIp = exit.ip.trim();

        const background = isSelected
          ? "var(--pink-100)"
          : isWarning
            ? "var(--amber-bg)"
            : "var(--pink-50)";
        const borderColor = isSelected
          ? "var(--pink-500)"
          : isWarning
            ? "var(--honey-300)"
            : "var(--line)";
        const textColor = isSelected
          ? "var(--pink-700)"
          : isWarning
            ? "var(--amber)"
            : "var(--ink-soft)";

        return (
          <button
            key={exitKey}
            type="button"
            onClick={() => onSelect(isSelected ? "" : exitKey)}
            title={
              isWarning
                ? `${exit.count} 个账户共用此出口 IP，点击筛选`
                : `点击按出口 ${displayIp} 筛选`
            }
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              minHeight: "28px",
              padding: "3px 11px",
              borderRadius: "var(--pill)",
              border: `1.5px solid ${borderColor}`,
              background,
              color: textColor,
              fontSize: "12px",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            {isWarning && <AlertTriangle size={12} />}
            <span
              className="mono"
              style={{
                color: isSelected ? "var(--pink-700)" : "var(--ink)",
                fontWeight: 700,
              }}
            >
              {displayIp}
            </span>
            {exit.country && (
              <span style={{ color: "var(--muted)", fontWeight: 600 }}>
                / {exit.country}
              </span>
            )}
            <span
              className="mono"
              style={{ color: "var(--muted)", fontWeight: 600 }}
            >
              / {exit.count}
            </span>
            {isWarning && (
              <span style={{ color: "var(--amber)", fontWeight: 800 }}>
                · {exit.count} 个账户共用
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

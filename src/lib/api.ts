export type Severity = "info" | "low" | "medium" | "high" | "critical";

export type Finding = {
  code: string;
  severity: Severity;
  sheet_name: string;
  cell: string | null;
  row_number: number | null;
  column_name: string | null;
  title: string;
  description: string;
  suggested_fix: string;
  evidence: Record<string, unknown>;
};

export type AuditReport = {
  id: string;
  file_name: string;
  status: string;
  risk_score: number;
  risk_level: string;
  total_findings: number;
  summary: string;
  recommendations: string[];
  findings: Finding[];
  created_at: string;
};

export type ComparisonMetric = {
  metric_name: string;
  current_value: number;
  previous_value: number;
  delta_value: number;
  delta_percent: number | null;
  severity: Severity;
};

export type ReportComparison = {
  current_report_id: string;
  previous_report_id: string | null;
  summary: string;
  metrics: ComparisonMetric[];
};

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

export async function uploadAudit(file: File, storeId: string, periodMonth: string): Promise<AuditReport> {
  const data = new FormData();
  data.append("file", file);
  data.append("store_id", storeId);
  data.append("period_month", periodMonth);

  const response = await fetch(`${API_URL}/api/v1/reports/upload`, {
    method: "POST",
    body: data,
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || "Не удалось проверить файл");
  }

  return response.json();
}

export async function fetchHistory(): Promise<AuditReport[]> {
  const response = await fetch(`${API_URL}/api/v1/reports`);
  if (!response.ok) {
    return [];
  }
  return response.json();
}

export async function fetchComparison(reportId: string): Promise<ReportComparison | null> {
  const response = await fetch(`${API_URL}/api/v1/reports/${reportId}/compare`);
  if (!response.ok) {
    return null;
  }
  return response.json();
}

export function pdfUrl(reportId: string) {
  return `${API_URL}/api/v1/reports/${reportId}/pdf`;
}

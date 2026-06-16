import { FormEvent, useEffect, useMemo, useState } from "react";
import { AuditReport, ReportComparison, fetchComparison, fetchHistory, pdfUrl, uploadAudit } from "./lib/api";
import "./index.css";

const severityLabel = {
  info: "Инфо",
  low: "Низкий",
  medium: "Средний",
  high: "Высокий",
  critical: "Критический",
};

const riskLabel: Record<string, string> = {
  low: "Низкий",
  medium: "Средний",
  high: "Высокий",
  critical: "Критический",
};

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [storeId, setStoreId] = useState("00000000-0000-0000-0000-000000000001");
  const [periodMonth, setPeriodMonth] = useState("2026-06");
  const [report, setReport] = useState<AuditReport | null>(null);
  const [comparison, setComparison] = useState<ReportComparison | null>(null);
  const [history, setHistory] = useState<AuditReport[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchHistory().then(setHistory).catch(() => setHistory([]));
  }, []);

  useEffect(() => {
    if (!report) {
      setComparison(null);
      return;
    }
    fetchComparison(report.id).then(setComparison).catch(() => setComparison(null));
  }, [report]);

  const highRiskCount = useMemo(
    () => report?.findings.filter((item) => ["high", "critical"].includes(item.severity)).length ?? 0,
    [report],
  );

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) {
      setError("Выберите Excel-файл .xlsx или .xls");
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const result = await uploadAudit(file, storeId, periodMonth);
      setReport(result);
      setHistory((items) => [result, ...items.filter((item) => item.id !== result.id)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка проверки");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Max Mara report control</p>
          <h1>Retail Report AI</h1>
          <p className="subtitle">
            Проверка Excel-отчетов по продажам, зарплатам, премиям, остаткам и расходам.
          </p>
        </div>
        {report ? (
          <a className="button secondary" href={pdfUrl(report.id)} target="_blank" rel="noreferrer">
            Скачать PDF
          </a>
        ) : null}
      </header>

      <section className="layout">
        <aside className="panel">
          <h2>Новая проверка</h2>
          <form className="form" onSubmit={onSubmit}>
            <label>
              Магазин
              <input value={storeId} onChange={(event) => setStoreId(event.target.value)} />
            </label>
            <label>
              Месяц отчета
              <input type="month" value={periodMonth} onChange={(event) => setPeriodMonth(event.target.value)} />
            </label>
            <label className="file-drop">
              <span>{file ? file.name : "Загрузить Excel"}</span>
              <small>.xlsx или .xls, все листы будут прочитаны автоматически</small>
              <input
                type="file"
                accept=".xlsx,.xls"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
            </label>
            {error ? <p className="error">{error}</p> : null}
            <button className="button" disabled={isLoading}>
              {isLoading ? "Проверяем..." : "Проверить отчет"}
            </button>
          </form>
        </aside>

        <section className="content">
          <div className="metrics">
            <Metric title="Ошибки" value={report?.total_findings ?? 0} />
            <Metric title="Риск" value={report ? riskLabel[report.risk_level] ?? report.risk_level : "Нет данных"} />
            <Metric title="Балл риска" value={report?.risk_score ?? 0} />
            <Metric title="Высокий риск" value={highRiskCount} />
          </div>

          <section className="panel">
            <h2>Итог проверки</h2>
            {report ? (
              <div className="stack">
                <div className="summary-box">
                  <strong>{report.file_name}</strong>
                  <p>{report.summary}</p>
                </div>
                <div className="recommendations">
                  {report.recommendations.map((item) => (
                    <div key={item}>{item}</div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="muted">Загрузите отчет, чтобы увидеть ошибки, подозрительные строки и рекомендации.</p>
            )}
          </section>

          <section className="panel">
            <h2>Сравнение с прошлым месяцем</h2>
            {comparison ? (
              <div className="stack">
                <p className="muted">{comparison.summary}</p>
                <div className="comparison-grid">
                  {comparison.metrics.map((item) => (
                    <div key={item.metric_name} className="comparison-item">
                      <strong>{metricName(item.metric_name)}</strong>
                      <span>
                        {item.previous_value} {"->"} {item.current_value}
                        {item.delta_percent !== null
                          ? ` (${item.delta_percent > 0 ? "+" : ""}${item.delta_percent}%)`
                          : ""}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="muted">Сравнение появится после выбора или загрузки отчета.</p>
            )}
          </section>

          <section className="panel">
            <h2>Найденные проблемы</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Риск</th>
                    <th>Лист</th>
                    <th>Ячейка</th>
                    <th>Описание</th>
                    <th>Что сделать</th>
                  </tr>
                </thead>
                <tbody>
                  {(report?.findings ?? []).map((finding, index) => (
                    <tr key={`${finding.code}-${index}`}>
                      <td>{severityLabel[finding.severity]}</td>
                      <td>{finding.sheet_name}</td>
                      <td>{finding.cell ?? "-"}</td>
                      <td>{finding.description}</td>
                      <td>{finding.suggested_fix}</td>
                    </tr>
                  ))}
                  {!report?.findings.length ? (
                    <tr>
                      <td colSpan={5} className="muted">
                        Пока нет данных проверки.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel">
            <h2>История</h2>
            <div className="history-list">
              {history.slice(0, 6).map((item) => (
                <button key={item.id} type="button" className="history-item" onClick={() => setReport(item)}>
                  <span>{item.file_name}</span>
                  <span>{riskLabel[item.risk_level] ?? item.risk_level}</span>
                </button>
              ))}
              {!history.length ? <p className="muted">История появится после первой проверки.</p> : null}
            </div>
          </section>
        </section>
      </section>
    </main>
  );
}

function Metric({ title, value }: { title: string; value: string | number }) {
  return (
    <div className="metric">
      <span>{title}</span>
      <strong>{value}</strong>
    </div>
  );
}

function metricName(name: string) {
  const labels: Record<string, string> = {
    risk_score: "Балл риска",
    total_findings: "Всего замечаний",
    critical_findings: "Критичные замечания",
    high_risk_findings: "Высокий риск",
  };
  return labels[name] ?? name;
}

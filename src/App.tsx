import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  AuditReport,
  ChatResponse,
  ManagementReport,
  ReportComparison,
  askReport,
  fetchComparison,
  fetchHistory,
  fetchManagementReport,
  pdfUrl,
  uploadAudit,
} from "./lib/api";
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

const kpiLabels: Record<string, string> = {
  sales: "Продажи",
  profit: "Прибыль",
  salary: "Зарплаты",
  bonus: "Премии",
  expense: "Расходы",
  discount: "Скидки",
  return: "Возвраты",
};

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [storeId, setStoreId] = useState("00000000-0000-0000-0000-000000000001");
  const [periodMonth, setPeriodMonth] = useState("2026-06");
  const [report, setReport] = useState<AuditReport | null>(null);
  const [comparison, setComparison] = useState<ReportComparison | null>(null);
  const [managementReport, setManagementReport] = useState<ManagementReport | null>(null);
  const [history, setHistory] = useState<AuditReport[]>([]);
  const [question, setQuestion] = useState("Почему прибыль снизилась?");
  const [chatAnswer, setChatAnswer] = useState<ChatResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isReportLoading, setIsReportLoading] = useState(false);
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchHistory().then(setHistory).catch(() => setHistory([]));
  }, []);

  useEffect(() => {
    if (!report) {
      setComparison(null);
      setManagementReport(null);
      setChatAnswer(null);
      return;
    }
    fetchComparison(report.id).then(setComparison).catch(() => setComparison(null));
  }, [report]);

  const highRiskCount = useMemo(
    () => report?.findings.filter((item) => ["high", "critical"].includes(item.severity)).length ?? 0,
    [report],
  );

  const fraudCount = useMemo(
    () =>
      report?.findings.filter((item) =>
        ["SUSPICIOUS_DISCOUNT", "MONTH_END_RETURN_SPIKE", "BONUS_LIMIT_EXCEEDED", "DUPLICATE_ROW"].includes(item.code),
      ).length ?? 0,
    [report],
  );

  const totals = report?.workbook_profile?.metric_totals ?? {};
  const qualityScore = report?.workbook_profile?.quality_score ?? (report ? Math.max(0, 100 - report.risk_score) : 0);

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

  async function createManagementReport() {
    if (!report) return;
    setIsReportLoading(true);
    try {
      setManagementReport(await fetchManagementReport(report.id));
    } finally {
      setIsReportLoading(false);
    }
  }

  async function askQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!report || !question.trim()) return;
    setIsChatLoading(true);
    try {
      setChatAnswer(await askReport(report.id, question.trim()));
    } finally {
      setIsChatLoading(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Режим: “Проведи аудит отчета”</p>
          <h1>Retail Report AI</h1>
          <p className="subtitle">
            AI-аудитор Excel-отчетов для магазинов: формулы, пустые ячейки, дубли, итоговые суммы, бизнес-логика,
            fraud-сигналы, сравнение месяцев и готовый отчет для руководства.
          </p>
        </div>
        {report ? (
          <a className="button secondary" href={pdfUrl(report.id)} target="_blank" rel="noreferrer">
            Скачать PDF
          </a>
        ) : null}
      </header>

      <section className="layout">
        <aside className="panel sticky-panel">
          <h2>Загрузка Excel</h2>
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
              <small>.xlsx или .xls. Все листы будут прочитаны автоматически.</small>
              <input
                type="file"
                accept=".xlsx,.xls"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
            </label>
            {error ? <p className="error">{error}</p> : null}
            <button className="button" disabled={isLoading}>
              {isLoading ? "Проводим аудит..." : "Провести аудит отчета"}
            </button>
          </form>

          <div className="roadmap-mini">
            <strong>Следующие модули SaaS</strong>
            <span>PDF и фото документов</span>
            <span>Голосовой помощник</span>
            <span>Сравнение 10-100 магазинов</span>
          </div>
        </aside>

        <section className="content">
          <div className="metrics">
            <Metric title="Качество" value={`${qualityScore}/100`} />
            <Metric title="Ошибки" value={report?.total_findings ?? 0} />
            <Metric title="Риск" value={report ? riskLabel[report.risk_level] ?? report.risk_level : "Нет данных"} />
            <Metric title="Высокий риск" value={highRiskCount} />
            <Metric title="Fraud" value={fraudCount} />
          </div>

          <section className="panel">
            <h2>Дашборд KPI</h2>
            <div className="kpi-grid">
              {Object.entries(kpiLabels).map(([key, label]) => (
                <KpiBar key={key} label={label} value={Number(totals[key] ?? 0)} max={maxKpi(totals)} />
              ))}
            </div>
          </section>

          <section className="panel">
            <h2>Итог аудита</h2>
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
            <div className="panel-head">
              <h2>Отчет для руководства</h2>
              <button className="button compact" type="button" disabled={!report || isReportLoading} onClick={createManagementReport}>
                {isReportLoading ? "Генерируем..." : "Создать отчет"}
              </button>
            </div>
            {managementReport ? (
              <div className="management-report">
                <strong>{managementReport.title}</strong>
                <p>{managementReport.text}</p>
                <div className="chips">
                  {managementReport.highlights.map((item) => (
                    <span key={item}>{item}</span>
                  ))}
                </div>
              </div>
            ) : (
              <p className="muted">
                Кнопка генерирует готовый текст: рост продаж, снижение прибыли, изменение зарплат, премий и расходов.
              </p>
            )}
          </section>

          <section className="panel">
            <h2>AI-чат с отчетом</h2>
            <form className="chat-form" onSubmit={askQuestion}>
              <input value={question} onChange={(event) => setQuestion(event.target.value)} />
              <button className="button compact" disabled={!report || isChatLoading}>
                {isChatLoading ? "Думаем..." : "Спросить"}
              </button>
            </form>
            {chatAnswer ? (
              <div className="chat-answer">
                <span>{chatAnswer.used_ai ? "AI-ответ" : "Ответ по правилам"}</span>
                <p>{chatAnswer.answer}</p>
              </div>
            ) : (
              <p className="muted">Примеры: “Почему прибыль снизилась?”, “Какие расходы выросли?”, “Есть ли подозрительные операции?”</p>
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
                        {formatMoney(item.previous_value)} {"->"} {formatMoney(item.current_value)}
                        {item.delta_percent !== null ? ` (${item.delta_percent > 0 ? "+" : ""}${item.delta_percent}%)` : ""}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="muted">Загрузите апрель, май, июнь — система покажет рост продаж, прибыль, зарплаты и отклонения.</p>
            )}
          </section>

          <section className="panel">
            <h2>Контроль мошенничества</h2>
            <div className="risk-grid">
              {["BONUS_LIMIT_EXCEEDED", "SUSPICIOUS_DISCOUNT", "MONTH_END_RETURN_SPIKE", "DUPLICATE_ROW"].map((code) => {
                const count = report?.findings.filter((item) => item.code === code).length ?? 0;
                return (
                  <div className="risk-card" key={code}>
                    <strong>{fraudLabel(code)}</strong>
                    <span>{count} сигналов</span>
                  </div>
                );
              })}
            </div>
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

function KpiBar({ label, value, max }: { label: string; value: number; max: number }) {
  const width = max > 0 ? Math.max(3, Math.min(100, (Math.abs(value) / max) * 100)) : 3;
  return (
    <div className="kpi-item">
      <div>
        <strong>{label}</strong>
        <span>{formatMoney(value)}</span>
      </div>
      <div className="bar-track">
        <div className="bar-fill" style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

function maxKpi(totals: Record<string, number>) {
  return Math.max(1, ...Object.values(totals).map((value) => Math.abs(Number(value) || 0)));
}

function formatMoney(value: number) {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(value);
}

function metricName(name: string) {
  const labels: Record<string, string> = {
    risk_score: "Балл риска",
    total_findings: "Всего замечаний",
    critical_findings: "Критичные замечания",
    high_risk_findings: "Высокий риск",
    sales: "Продажи",
    profit: "Прибыль",
    salary: "Зарплаты",
    bonus: "Премии",
    expense: "Расходы",
  };
  return labels[name] ?? name;
}

function fraudLabel(code: string) {
  const labels: Record<string, string> = {
    BONUS_LIMIT_EXCEEDED: "Необычные премии",
    SUSPICIOUS_DISCOUNT: "Подозрительные скидки",
    MONTH_END_RETURN_SPIKE: "Возвраты перед закрытием",
    DUPLICATE_ROW: "Дубли операций",
  };
  return labels[code] ?? code;
}

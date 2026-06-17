import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  AuditReport,
  ChatResponse,
  Finding,
  ManagementReport,
  ReportComparison,
  Severity,
  fetchComparison,
  fetchHistory,
  fetchManagementReport,
  pdfUrl,
  uploadAudit,
} from "./lib/api";
import { BrandLogo } from "./components/BrandLogo";
import { FashionAssistant } from "./components/FashionAssistant";
import { demoComparison, demoManagementReport, demoReport } from "./lib/demoReport";
import "./index.css";

type Page = "kpi" | "audits" | "stats";

const severityLabel: Record<Severity, string> = {
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
  salary: "Зарплата",
  bonus: "Премии",
  expense: "Расходы",
  discount: "Скидки",
  return: "Возвраты",
};

const acceptDocuments = [
  ".xlsx",
  ".xls",
  ".xlsm",
  ".xlsb",
  ".csv",
  ".tsv",
  ".ods",
  ".pdf",
  ".txt",
  ".json",
  ".xml",
  ".html",
  ".md",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".doc",
  ".docx",
].join(",");

export default function App() {
  const [page, setPage] = useState<Page>("kpi");
  const [file, setFile] = useState<File | null>(null);
  const [storeId, setStoreId] = useState("00000000-0000-0000-0000-000000000001");
  const [periodMonth, setPeriodMonth] = useState("2026-06");
  const [report, setReport] = useState<AuditReport | null>(null);
  const [comparison, setComparison] = useState<ReportComparison | null>(null);
  const [managementReport, setManagementReport] = useState<ManagementReport | null>(null);
  const [history, setHistory] = useState<AuditReport[]>([]);
  const [question, setQuestion] = useState("Что важнее проверить в этом документе?");
  const [chatAnswer, setChatAnswer] = useState<ChatResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isReportLoading, setIsReportLoading] = useState(false);
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isDemoReport = report?.id === demoReport.id;
  const totals = report?.workbook_profile?.metric_totals ?? {};
  const qualityScore = report?.workbook_profile?.quality_score ?? (report ? Math.max(0, 100 - report.risk_score) : 0);
  const highRiskCount = report?.findings.filter((item) => ["high", "critical"].includes(item.severity)).length ?? 0;
  const fraudCount =
    report?.findings.filter((item) =>
      ["SUSPICIOUS_DISCOUNT", "MONTH_END_RETURN_SPIKE", "BONUS_LIMIT_EXCEEDED", "DUPLICATE_ROW"].includes(item.code),
    ).length ?? 0;

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
    if (report.id === demoReport.id) {
      setComparison(demoComparison);
      return;
    }
    fetchComparison(report.id).then(setComparison).catch(() => setComparison(null));
  }, [report]);

  const monthlyRows = useMemo(() => buildMonthlyRows(history, report), [history, report]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) {
      setError("Выберите документ: Excel, CSV, PDF, TXT, изображение или другой файл.");
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const result = await uploadAudit(file, storeId, periodMonth);
      setReport(result);
      setHistory((items) => [result, ...items.filter((item) => item.id !== result.id)]);
      setManagementReport(null);
      setChatAnswer(null);
      setPage("audits");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось проверить документ");
    } finally {
      setIsLoading(false);
    }
  }

  function openDemoReport() {
    setError(null);
    setFile(null);
    setReport(demoReport);
    setComparison(demoComparison);
    setManagementReport(demoManagementReport);
    setChatAnswer(null);
    setHistory((items) => [demoReport, ...items.filter((item) => item.id !== demoReport.id)]);
    setPage("audits");
  }

  async function createManagementReport() {
    if (!report) return;
    if (isDemoReport) {
      setManagementReport(demoManagementReport);
      return;
    }
    setIsReportLoading(true);
    try {
      setManagementReport((await fetchManagementReport(report.id)) ?? buildLocalManagementReport(report));
    } catch {
      setManagementReport(buildLocalManagementReport(report));
    } finally {
      setIsReportLoading(false);
    }
  }

  async function askGemini(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!question.trim()) return;
    const localAnswer = report
      ? buildLocalReportAnswer(report, question.trim())
      : {
          used_ai: false,
          answer:
            "Gemini сейчас получит вопрос без загруженного документа. Для точного ответа по цифрам загрузите отчет, а пока я могу отвечать как retail-помощник по KPI, продажам, аудиту и документам.",
        };
    setChatAnswer(localAnswer);
    setIsChatLoading(true);

    try {
      const { supabase } = await import("./lib/supabase");
      const { data, error } = await withTimeout(
        supabase.functions.invoke("ai", {
          body: {
            system:
              "Ты Gemini AI-аудитор и помощник владельца fashion retail. Отвечай по-русски, коротко и по делу. Используй только переданные данные документа, KPI и findings. Не придумывай числа.",
            prompt: report
              ? buildGeminiReportPrompt(report, question.trim())
              : `Ответь владельцу магазина одежды на вопрос. Если для точного ответа нужен файл или цифры, прямо скажи, какие документы загрузить. Вопрос: ${question.trim()}`,
          },
        }),
        10000,
      );
      if (!error && typeof data?.text === "string" && data.text.trim()) {
        setChatAnswer({ answer: data.text.trim(), used_ai: true });
      }
    } catch {
      // Local answer is already visible.
    } finally {
      setIsChatLoading(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="header-copy">
          <BrandLogo />
          <p className="eyebrow">Fashion retail workspace</p>
          <h1>Управление магазином: KPI, аудиты, статистика</h1>
          <p className="subtitle">
            Загружайте отчеты и документы, проверяйте риски, сравнивайте месяцы и задавайте вопросы Gemini по данным магазина.
          </p>
        </div>
        <div className="header-actions">
          {report && !isDemoReport ? (
            <a className="button secondary" href={pdfUrl(report.id)} target="_blank" rel="noreferrer">
              PDF
            </a>
          ) : null}
          <button className="button" type="button" onClick={openDemoReport}>
            Демо
          </button>
        </div>
      </header>

      <nav className="page-tabs" aria-label="Разделы">
        <TabButton active={page === "kpi"} onClick={() => setPage("kpi")} label="KPI" />
        <TabButton active={page === "audits"} onClick={() => setPage("audits")} label="Аудиты и документы" />
        <TabButton active={page === "stats"} onClick={() => setPage("stats")} label="Статистика по месяцам" />
      </nav>

      <section className="workspace">
        <aside className="upload-panel">
          <form className="form" onSubmit={onSubmit}>
            <div>
              <h2>Загрузка документа</h2>
              <p className="muted">Excel, CSV, PDF, TXT, изображения и офисные документы. Таблицы читаются локально, сложные файлы отправляются в Gemini.</p>
            </div>
            <label>
              Магазин
              <input value={storeId} onChange={(event) => setStoreId(event.target.value)} />
            </label>
            <label>
              Месяц отчета
              <input type="month" value={periodMonth} onChange={(event) => setPeriodMonth(event.target.value)} />
            </label>
            <label className="file-drop">
              <span>{file ? file.name : "Выбрать документ"}</span>
              <small>Поддерживаются таблицы, PDF, текст, изображения и офисные файлы.</small>
              <input type="file" accept={acceptDocuments} onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
            </label>
            {error ? <p className="error">{error}</p> : null}
            <button className="button" disabled={isLoading}>
              {isLoading ? "Проверяю..." : "Загрузить и проверить"}
            </button>
          </form>

          <div className="current-report">
            <span>Текущий документ</span>
            <strong>{report?.file_name ?? "Нет документа"}</strong>
            <small>{report ? `${riskLabel[report.risk_level] ?? report.risk_level}, ошибок: ${report.total_findings}` : "Откройте демо или загрузите файл"}</small>
          </div>
        </aside>

        <section className="page-content">
          {page === "kpi" ? (
            <KpiPage report={report} totals={totals} qualityScore={qualityScore} highRiskCount={highRiskCount} fraudCount={fraudCount} />
          ) : null}
          {page === "audits" ? (
            <AuditsPage
              report={report}
              isDemoReport={isDemoReport}
              managementReport={managementReport}
              isReportLoading={isReportLoading}
              createManagementReport={createManagementReport}
              question={question}
              setQuestion={setQuestion}
              askGemini={askGemini}
              chatAnswer={chatAnswer}
              isChatLoading={isChatLoading}
              history={history}
              selectReport={setReport}
            />
          ) : null}
          {page === "stats" ? <StatsPage report={report} comparison={comparison} rows={monthlyRows} /> : null}
        </section>
      </section>
    </main>
  );
}

function KpiPage({
  report,
  totals,
  qualityScore,
  highRiskCount,
  fraudCount,
}: {
  report: AuditReport | null;
  totals: Record<string, number>;
  qualityScore: number;
  highRiskCount: number;
  fraudCount: number;
}) {
  return (
    <div className="page-stack">
      <section className="hero-strip">
        <div>
          <p className="eyebrow">KPI dashboard</p>
          <h2>KPI магазина на одной странице</h2>
          <p>Продажи, прибыль, расходы, скидки и возвраты собраны в одном месте, чтобы быстро понять состояние месяца.</p>
        </div>
      </section>

      <div className="metrics">
        <Metric title="Качество" value={`${qualityScore}/100`} />
        <Metric title="Ошибки" value={report?.total_findings ?? 0} />
        <Metric title="Высокий риск" value={highRiskCount} />
        <Metric title="Fraud-сигналы" value={fraudCount} />
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>Финансовые KPI</h2>
          <span className="soft-pill">{report ? report.file_name : "Нет файла"}</span>
        </div>
        <div className="kpi-grid">
          {Object.entries(kpiLabels).map(([key, label]) => (
            <KpiBar key={key} label={label} value={Number(totals[key] ?? 0)} max={maxKpi(totals)} />
          ))}
        </div>
      </section>

      <FashionAssistant report={report} />
    </div>
  );
}

function AuditsPage({
  report,
  isDemoReport,
  managementReport,
  isReportLoading,
  createManagementReport,
  question,
  setQuestion,
  askGemini,
  chatAnswer,
  isChatLoading,
  history,
  selectReport,
}: {
  report: AuditReport | null;
  isDemoReport: boolean;
  managementReport: ManagementReport | null;
  isReportLoading: boolean;
  createManagementReport: () => void;
  question: string;
  setQuestion: (value: string) => void;
  askGemini: (event: FormEvent<HTMLFormElement>) => void;
  chatAnswer: ChatResponse | null;
  isChatLoading: boolean;
  history: AuditReport[];
  selectReport: (report: AuditReport) => void;
}) {
  return (
    <div className="page-stack">
      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Audit workspace</p>
            <h2>Аудиты и документы</h2>
          </div>
          {isDemoReport ? <span className="soft-pill">Демо</span> : null}
        </div>

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
          <p className="muted">Загрузите документ или откройте демо, чтобы увидеть аудит.</p>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Отчет для руководства</h2>
          <button className="button compact" type="button" disabled={!report || isReportLoading} onClick={createManagementReport}>
            {isReportLoading ? "Готовлю..." : "Создать"}
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
          <p className="muted">Короткая управленческая выжимка появится здесь после генерации.</p>
        )}
      </section>

      <section className="panel">
        <h2>Gemini-чат по документу</h2>
        <form className="chat-form" onSubmit={askGemini}>
          <input value={question} onChange={(event) => setQuestion(event.target.value)} />
          <button className="button compact" disabled={isChatLoading || !question.trim()}>
            {isChatLoading ? "Gemini думает..." : "Спросить"}
          </button>
        </form>
        {chatAnswer ? (
          <div className="chat-answer">
            <span>{chatAnswer.used_ai ? "Gemini" : "Локальный ответ"}</span>
            <p>{chatAnswer.answer}</p>
          </div>
        ) : (
          <p className="muted">Например: “где риск по скидкам?”, “что проверить первым?”, “почему прибыль ниже?”.</p>
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
                    Пока нет данных аудита.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <h2>История документов</h2>
        <div className="history-list">
          {history.map((item) => (
            <button className="history-item" type="button" key={item.id} onClick={() => selectReport(item)}>
              <span>{item.file_name}</span>
              <small>{new Date(item.created_at).toLocaleDateString("ru-RU")}</small>
            </button>
          ))}
          {!history.length ? <p className="muted">История появится после первой проверки.</p> : null}
        </div>
      </section>
    </div>
  );
}

function StatsPage({ report, comparison, rows }: { report: AuditReport | null; comparison: ReportComparison | null; rows: MonthlyRow[] }) {
  return (
    <div className="page-stack">
      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Month over month</p>
            <h2>Статистика и сравнение всех месяцев</h2>
          </div>
          <span className="soft-pill">{rows.length} мес.</span>
        </div>

        {comparison ? (
          <div className="stack">
            <p className="muted">{comparison.summary}</p>
            <div className="comparison-grid">
              {comparison.metrics.map((item) => (
                <div key={item.metric_name} className="comparison-item">
                  <strong>{metricName(item.metric_name)}</strong>
                  <span>
                    {formatNumber(item.previous_value)} → {formatNumber(item.current_value)}
                    {item.delta_percent !== null ? ` (${item.delta_percent > 0 ? "+" : ""}${item.delta_percent}%)` : ""}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="muted">Загрузите минимум два месяца, чтобы увидеть сравнение с прошлым периодом.</p>
        )}
      </section>

      <section className="panel">
        <h2>Все месяцы</h2>
        <div className="month-chart">
          {rows.map((row) => (
            <div className="month-row" key={row.key}>
              <strong>{row.label}</strong>
              <div className="month-bars">
                <MiniBar label="Продажи" value={row.sales} max={maxRows(rows, "sales")} />
                <MiniBar label="Прибыль" value={row.profit} max={maxRows(rows, "profit")} />
                <MiniBar label="Расходы" value={row.expense} max={maxRows(rows, "expense")} />
                <MiniBar label="Риск" value={row.riskScore} max={100} />
              </div>
            </div>
          ))}
          {!rows.length ? <p className="muted">Нет данных для месячной статистики.</p> : null}
        </div>
      </section>

      <section className="panel">
        <h2>Текущий месяц</h2>
        {report ? (
          <div className="risk-grid">
            <RiskCard title="Риск" value={riskLabel[report.risk_level] ?? report.risk_level} />
            <RiskCard title="Баллы риска" value={report.risk_score} />
            <RiskCard title="Замечания" value={report.total_findings} />
            <RiskCard title="Качество" value={`${report.workbook_profile?.quality_score ?? Math.max(0, 100 - report.risk_score)}/100`} />
          </div>
        ) : (
          <p className="muted">Выберите документ, чтобы увидеть сводку месяца.</p>
        )}
      </section>
    </div>
  );
}

function TabButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button className={active ? "tab active" : "tab"} type="button" onClick={onClick}>
      {label}
    </button>
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

function MiniBar({ label, value, max }: { label: string; value: number; max: number }) {
  const width = max > 0 ? Math.max(4, Math.min(100, (Math.abs(value) / max) * 100)) : 4;
  return (
    <div className="mini-bar">
      <span>{label}</span>
      <div className="bar-track">
        <div className="bar-fill" style={{ width: `${width}%` }} />
      </div>
      <strong>{label === "Риск" ? value : formatMoney(value)}</strong>
    </div>
  );
}

function RiskCard({ title, value }: { title: string; value: string | number }) {
  return (
    <div className="risk-card">
      <strong>{title}</strong>
      <span>{value}</span>
    </div>
  );
}

function maxKpi(totals: Record<string, number>) {
  return Math.max(1, ...Object.values(totals).map((value) => Math.abs(Number(value) || 0)));
}

function formatMoney(value: number) {
  return `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(value)} ₽`;
}

function formatNumber(value: number) {
  return Math.abs(value) >= 1000 ? formatMoney(value) : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(value);
}

function buildLocalManagementReport(report: AuditReport): ManagementReport {
  const totals = report.workbook_profile?.metric_totals ?? {};
  const highRisk = report.findings.filter((item) => ["high", "critical"].includes(item.severity)).length;
  const topFindings = prioritizeFindings(report.findings).slice(0, 3);

  return {
    report_id: report.id,
    title: `Отчет для руководства: ${report.file_name}`,
    text: [
      `Проверка завершена. Риск: ${riskLabel[report.risk_level] ?? report.risk_level}, качество: ${report.workbook_profile?.quality_score ?? Math.max(0, 100 - report.risk_score)}/100.`,
      `Замечаний: ${report.total_findings}, высокий/критический риск: ${highRisk}.`,
      report.summary,
      topFindings.length ? `Первым делом проверьте: ${topFindings.map((item) => item.title).join("; ")}.` : "Критичных зон по текущим правилам не найдено.",
    ].join(" "),
    highlights: [
      `Продажи: ${formatMoney(Number(totals.sales ?? 0))}`,
      `Прибыль: ${formatMoney(Number(totals.profit ?? 0))}`,
      `Скидки: ${formatMoney(Number(totals.discount ?? 0))}`,
      `Возвраты: ${formatMoney(Number(totals.return ?? 0))}`,
    ],
  };
}

function buildLocalReportAnswer(report: AuditReport, question: string): ChatResponse {
  const totals = report.workbook_profile?.metric_totals ?? {};
  const topFindings = prioritizeFindings(report.findings);
  return {
    used_ai: false,
    answer: [
      `Отвечаю по загруженному документу: ${report.file_name}. Риск: ${riskLabel[report.risk_level] ?? report.risk_level}, замечаний: ${report.total_findings}.`,
      `Ключевые суммы: продажи ${formatMoney(Number(totals.sales ?? 0))}, прибыль ${formatMoney(Number(totals.profit ?? 0))}, расходы ${formatMoney(Number(totals.expense ?? 0))}, скидки ${formatMoney(Number(totals.discount ?? 0))}, возвраты ${formatMoney(Number(totals.return ?? 0))}.`,
      topFindings[0] ? `Первое, что стоит проверить: ${topFindings[0].title}. ${topFindings[0].suggested_fix}` : "Серьезных замечаний не найдено.",
      `Вопрос: ${question}`,
    ].join(" "),
  };
}

function buildGeminiReportPrompt(report: AuditReport, question: string) {
  const payload = {
    question,
    file_name: report.file_name,
    risk_score: report.risk_score,
    risk_level: report.risk_level,
    summary: report.summary,
    recommendations: report.recommendations,
    workbook_profile: report.workbook_profile,
    findings: report.findings.slice(0, 60).map((item) => ({
      code: item.code,
      severity: item.severity,
      sheet: item.sheet_name,
      cell: item.cell,
      title: item.title,
      description: item.description,
      suggested_fix: item.suggested_fix,
    })),
  };
  return `Ответь на вопрос владельца магазина по этому документу. Данные:\n${JSON.stringify(payload, null, 2)}`;
}

function prioritizeFindings(findings: Finding[]) {
  const weight: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  return [...findings].sort((a, b) => weight[a.severity] - weight[b.severity]);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      window.setTimeout(() => reject(new Error("Request timed out")), timeoutMs);
    }),
  ]);
}

type MonthlyRow = {
  key: string;
  label: string;
  sales: number;
  profit: number;
  expense: number;
  riskScore: number;
};

function buildMonthlyRows(history: AuditReport[], report: AuditReport | null): MonthlyRow[] {
  const map = new Map<string, AuditReport>();
  [...history, ...(report ? [report] : [])].forEach((item) => {
    const key = item.created_at.slice(0, 7);
    if (!map.has(key)) map.set(key, item);
  });

  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => {
      const totals = item.workbook_profile?.metric_totals ?? {};
      return {
        key,
        label: new Date(`${key}-01T00:00:00`).toLocaleDateString("ru-RU", { month: "long", year: "numeric" }),
        sales: Number(totals.sales ?? 0),
        profit: Number(totals.profit ?? 0),
        expense: Number(totals.expense ?? 0),
        riskScore: item.risk_score,
      };
    });
}

function maxRows(rows: MonthlyRow[], field: "sales" | "profit" | "expense" | "riskScore") {
  return Math.max(1, ...rows.map((row) => Math.abs(row[field])));
}

function metricName(name: string) {
  const labels: Record<string, string> = {
    risk_score: "Балл риска",
    total_findings: "Всего замечаний",
    critical_findings: "Критичные замечания",
    high_risk_findings: "Высокий риск",
    sales: "Продажи",
    profit: "Прибыль",
    salary: "Зарплата",
    bonus: "Премии",
    expense: "Расходы",
    discount: "Скидки",
    return: "Возвраты",
  };
  return labels[name] ?? name;
}

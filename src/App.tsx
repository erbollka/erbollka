import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  AuditReport,
  ChatResponse,
  Finding,
  ManagementReport,
  ReportComparison,
  Severity,
  askReport,
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
  const isDemoReport = report?.id === demoReport.id;

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
      setManagementReport(null);
      setChatAnswer(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка проверки");
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
    setChatAnswer({
      used_ai: false,
      answer:
        "В демо-отчете риск вырос из-за расхождения итоговой строки, премии выше лимита, крупной скидки и возврата перед закрытием месяца.",
    });
    setHistory((items) => [demoReport, ...items.filter((item) => item.id !== demoReport.id)]);
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

  async function askQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!report || !question.trim()) return;
    if (isDemoReport) {
      setChatAnswer({
        used_ai: false,
        answer:
          "Это демо-ответ: в отчете заметны три главные причины риска — неверный итог продаж, премия выше лимита и подозрительные операции со скидками/возвратами.",
      });
      return;
    }
    setIsChatLoading(true);
    setChatAnswer(buildLocalReportAnswer(report, question.trim()));
    try {
      setChatAnswer(await withTimeout(askReport(report.id, question.trim()), 8000));
    } catch {
      // The local report answer is already shown. Backend AI is optional.
    } finally {
      setIsChatLoading(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <BrandLogo />
          <p className="eyebrow">Fashion retail workspace</p>
          <h1>Fashion Retail AI Assistant</h1>
          <p className="subtitle">
            Личный AI-помощник для магазина одежды: еженедельные KPI, продажи, выручка, скидки, возвраты,
            идеи для команды, витрины, ассортимента и планерок.
          </p>
        </div>
        {report ? (
          isDemoReport ? (
            <span className="demo-badge">Демо-отчет</span>
          ) : (
            <a className="button secondary" href={pdfUrl(report.id)} target="_blank" rel="noreferrer">
              Скачать PDF
            </a>
          )
        ) : null}
      </header>

      <section className="layout">
        <aside className="panel sticky-panel">
          <h2>Данные магазина</h2>
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
            <div className="button-row">
              <button className="button" disabled={isLoading}>
                {isLoading ? "Обновляем данные..." : "Загрузить отчет"}
              </button>
              <button className="button secondary" type="button" onClick={openDemoReport}>
                Демо-магазин
              </button>
            </div>
          </form>

          <div className="roadmap-mini">
            <strong>Fashion assistant modules</strong>
            <span>Еженедельные KPI команды</span>
            <span>Идеи для витрины и капсул</span>
            <span>Анализ скидок, возвратов и выручки</span>
          </div>
        </aside>

        <section className="content">
          <section className="assistant-hero">
            <div>
              <p className="eyebrow">AI co-pilot for store teams</p>
              <h2>Обсуждайте продажи, тренды и действия на неделю в одном месте</h2>
              <p>
                Ассистент использует KPI магазина и отчетность, чтобы помочь команде придумать план продаж,
                улучшить мерчандайзинг, подготовить планерку и найти идеи для fashion retail.
              </p>
            </div>
            <div className="hero-actions">
              <button className="button" type="button" onClick={openDemoReport}>
                Открыть демо-магазин
              </button>
              <span>Работает через Supabase AI Function, с fallback-ответом без ключа.</span>
            </div>
          </section>

          <FashionAssistant report={report} />

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
                {isDemoReport ? (
                  <div className="demo-note">
                    Это демонстрационный отчет: он показывает, как будет выглядеть результат без загрузки Excel.
                  </div>
                ) : null}
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
  return `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(value)} ₸`;
}

function buildLocalManagementReport(report: AuditReport): ManagementReport {
  const totals = report.workbook_profile?.metric_totals ?? {};
  const highRisk = report.findings.filter((item) => ["high", "critical"].includes(item.severity)).length;
  const fraudSignals = report.findings.filter((item) =>
    ["SUSPICIOUS_DISCOUNT", "MONTH_END_RETURN_SPIKE", "BONUS_LIMIT_EXCEEDED", "DUPLICATE_ROW"].includes(item.code),
  ).length;
  const topFindings = prioritizeFindings(report.findings).slice(0, 3);

  return {
    report_id: report.id,
    title: `Отчет для руководства: ${report.file_name}`,
    text: [
      `Проверка завершена. Общий риск: ${riskLabel[report.risk_level] ?? report.risk_level}, качество отчета: ${
        report.workbook_profile?.quality_score ?? Math.max(0, 100 - report.risk_score)
      }/100.`,
      `Найдено замечаний: ${report.total_findings}, из них высокого/критического риска: ${highRisk}. Fraud-сигналов: ${fraudSignals}.`,
      report.summary,
      topFindings.length
        ? `Главные зоны внимания: ${topFindings.map((item) => `${item.title} (${item.sheet_name}${item.cell ? `, ${item.cell}` : ""})`).join("; ")}.`
        : "Критичных зон внимания по текущим правилам не найдено.",
      `Главное действие: ${report.recommendations[0] ?? "сверить ключевые показатели и повторить проверку после исправлений."}`,
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
  const lowerQuestion = question.toLowerCase();
  const topFindings = prioritizeFindings(report.findings);
  const sales = Number(totals.sales ?? 0);
  const profit = Number(totals.profit ?? 0);
  const expense = Number(totals.expense ?? 0);
  const discount = Number(totals.discount ?? 0);
  const returns = Number(totals.return ?? 0);
  const discountShare = percentOf(discount, sales);
  const returnsShare = percentOf(returns, sales);
  const profitShare = percentOf(profit, sales);

  if (lowerQuestion.includes("приб") || lowerQuestion.includes("profit")) {
    return {
      used_ai: false,
      answer: [
        `По отчету прибыль сейчас ${formatMoney(profit)} (${profitShare}% от продаж).`,
        `Что может влиять: расходы ${formatMoney(expense)}, скидки ${formatMoney(discount)} (${discountShare}%), возвраты ${formatMoney(returns)} (${returnsShare}%).`,
        "План проверки: сначала сверьте итоговые формулы, затем крупные скидки/возвраты, затем расходы и премии.",
        topFindings[0] ? `Самый важный риск в файле: ${topFindings[0].title}. ${topFindings[0].suggested_fix}` : "",
      ]
        .filter(Boolean)
        .join(" "),
    };
  }

  if (lowerQuestion.includes("скид") || lowerQuestion.includes("возврат")) {
    return {
      used_ai: false,
      answer: [
        `Скидки: ${formatMoney(discount)} (${discountShare}% от продаж), возвраты: ${formatMoney(returns)} (${returnsShare}% от продаж).`,
        "Проверьте три вещи: кто разрешил скидку, есть ли основание в акции/чеке, не попали ли возвраты в конец периода.",
        "Для команды: сначала продавать образ и ценность комплекта, а скидку использовать только как последний аргумент.",
      ].join(" "),
    };
  }

  if (lowerQuestion.includes("продаж") || lowerQuestion.includes("выруч")) {
    return {
      used_ai: false,
      answer: [
        `Продажи по отчету: ${formatMoney(sales)}.`,
        `Для роста на ближайшую неделю: выберите товар недели, соберите 2-3 готовых комплекта и отслеживайте средний чек через допродажи.`,
        `Следите, чтобы рост не съедался скидками (${discountShare}%) и возвратами (${returnsShare}%).`,
      ].join(" "),
    };
  }

  if (
    lowerQuestion.includes("ассортимент") ||
    lowerQuestion.includes("товар") ||
    lowerQuestion.includes("витрин") ||
    lowerQuestion.includes("сервис") ||
    lowerQuestion.includes("команд")
  ) {
    return {
      used_ai: false,
      answer: [
        "По загруженному отчету я вижу финансовую часть и риски, поэтому связываю советы с цифрами.",
        `Продажи: ${formatMoney(sales)}, прибыль: ${formatMoney(profit)}, скидки: ${formatMoney(discount)} (${discountShare}%), возвраты: ${formatMoney(returns)} (${returnsShare}%).`,
        "Что сделать: выделить товар недели, собрать 2-3 готовых комплекта, дать продавцам короткий сценарий под поводы клиента: работа, семья, выходной, подарок.",
        "Что проверить в файле: какие категории дают продажи без скидки, где возвраты выше обычного, какие товары продаются только со скидкой.",
        topFindings[0] ? `Риск, который нельзя игнорировать: ${topFindings[0].title}. ${topFindings[0].suggested_fix}` : "",
      ]
        .filter(Boolean)
        .join(" "),
    };
  }

  if (lowerQuestion.includes("риск") || lowerQuestion.includes("ошиб") || lowerQuestion.includes("аудит")) {
    return {
      used_ai: false,
      answer: [
        `Уровень риска: ${riskLabel[report.risk_level] ?? report.risk_level}, замечаний: ${report.total_findings}.`,
        topFindings.length
          ? `Приоритет исправлений: ${topFindings.map((item, index) => `${index + 1}. ${item.title} - ${item.suggested_fix}`).join(" ")}`
          : "Серьезных замечаний не найдено.",
        "После исправлений загрузите файл повторно и сравните качество отчета.",
      ].join(" "),
    };
  }

  return {
    used_ai: false,
    answer: [
      `Я отвечаю не по шаблону, а по загруженному отчету и вашему вопросу: “${question}”. В файле найдено ${report.total_findings} замечаний, уровень риска - ${
        riskLabel[report.risk_level] ?? report.risk_level
      }.`,
      buildQuestionSpecificAdvice(lowerQuestion, {
        sales,
        profit,
        expense,
        discount,
        returns,
        discountShare,
        returnsShare,
        profitShare,
      }),
      topFindings[0] ? `Первое, что стоит проверить в аудите: ${topFindings[0].title}. ${topFindings[0].suggested_fix}` : report.summary,
      report.recommendations[0] ? `Рекомендация: ${report.recommendations[0]}` : "",
      `Ключевые цифры: продажи ${formatMoney(sales)}, прибыль ${formatMoney(profit)}, скидки ${formatMoney(discount)}, возвраты ${formatMoney(returns)}.`,
    ]
      .filter(Boolean)
      .join(" "),
  };
}

function prioritizeFindings(findings: Finding[]) {
  const weight: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  return [...findings].sort((a, b) => weight[a.severity] - weight[b.severity]);
}

function percentOf(value: number, total: number) {
  return total > 0 ? Math.round((value / total) * 100) : 0;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      window.setTimeout(() => reject(new Error("Request timed out")), timeoutMs);
    }),
  ]);
}

function buildQuestionSpecificAdvice(
  question: string,
  metrics: {
    sales: number;
    profit: number;
    expense: number;
    discount: number;
    returns: number;
    discountShare: number;
    returnsShare: number;
    profitShare: number;
  },
) {
  if (question.includes("почему") || question.includes("причин") || question.includes("упал") || question.includes("сниз")) {
    return `Ищите причину по цепочке: продажи ${formatMoney(metrics.sales)}, прибыль ${metrics.profitShare}%, расходы ${formatMoney(metrics.expense)}, скидки ${metrics.discountShare}%, возвраты ${metrics.returnsShare}%. Если скидки или возвраты растут быстрее продаж, проблема может быть не в спросе, а в качестве продаж и контроле операций.`;
  }
  if (question.includes("что делать") || question.includes("как") || question.includes("улучш") || question.includes("поднять")) {
    return "Практичный план: выберите один KPI на неделю, назначьте товар/комплект недели, дайте продавцам короткий скрипт под клиентский повод и каждый вечер сверяйте результат с продажами, скидками и возвратами.";
  }
  if (question.includes("клиент") || question.includes("сервис") || question.includes("возраж") || question.includes("дорого")) {
    return "По сервису: продавцу нужно начинать не с цены, а с повода клиента. Работа, семья, выходной, подарок, поездка - под каждый повод можно собрать образ и только потом обсуждать цену или альтернативу.";
  }
  if (question.includes("ассортимент") || question.includes("размер") || question.includes("товар") || question.includes("закуп")) {
    return "По ассортименту: проверьте, какие товары меряют, но не покупают; какие продаются только со скидкой; каких размеров не хватает; какие вещи не имеют пары для готового образа.";
  }
  if (question.includes("соц") || question.includes("instagram") || question.includes("инст") || question.includes("контент")) {
    return "Для контента лучше показывать не отдельную вещь, а жизненный сценарий: семейный выход, офисная неделя, подарок, вечер. Это поддерживает продажи без постоянной скидки.";
  }
  return "Я бы проверила вопрос через три линзы: деньги, клиент, команда. Деньги - что происходит с прибылью, скидками и возвратами. Клиент - какой повод закрывает товар. Команда - может ли продавец объяснить предложение просто и тепло.";
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

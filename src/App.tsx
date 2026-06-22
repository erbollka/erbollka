import { FormEvent, useEffect, useMemo, useState } from "react";
import { User } from "@supabase/supabase-js";
import {
  AuditReport,
  ChatResponse,
  Finding,
  ReportComparison,
  Severity,
  fetchComparison,
  fetchHistory,
  pdfUrl,
  uploadAudit,
} from "./lib/api";
import { BrandLogo } from "./components/BrandLogo";
import { demoComparison, demoReport } from "./lib/demoReport";
import { supabase } from "./lib/supabase";
import "./index.css";

type Page = "kpi" | "audits" | "stats" | "chat";
type AuthMode = "signin" | "signup";

type ChatPhoto = {
  name: string;
  mimeType: string;
  data: string;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  imageUrl?: string;
  photos?: Array<{ name: string; url: string }>;
  source?: "gemini" | "fallback";
  model?: string;
};

type HistoryRiskFilter = "all" | "high" | "medium" | "low";
type AiStatus = {
  label: string;
  tone: "idle" | "thinking" | "ready" | "fallback" | "error";
  detail: string;
};

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

const mainKpiKeys = ["sales", "profit", "expense", "return"];
const visibleFindingsLimit = 5;
const chatPromptTemplates = [
  "Что проверить в первую очередь?",
  "Сделай план роста на неделю",
  "Объясни риски простыми словами",
  "Напиши сообщение сотруднику",
  "Сравни с прошлым месяцем",
];
const idleAiStatus: AiStatus = {
  label: "Gemini готов",
  tone: "idle",
  detail: "Ответы могут учитывать отчет, память и фото.",
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
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [isCloudDataReady, setIsCloudDataReady] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>("signin");
  const [page, setPage] = useState<Page>("kpi");
  const [file, setFile] = useState<File | null>(null);
  const [storeId, setStoreId] = useState("00000000-0000-0000-0000-000000000001");
  const [periodMonth, setPeriodMonth] = useState("2026-06");
  const [report, setReport] = useState<AuditReport | null>(null);
  const [comparison, setComparison] = useState<ReportComparison | null>(null);
  const [history, setHistory] = useState<AuditReport[]>([]);
  const [question, setQuestion] = useState("Дай короткий план роста магазина на неделю");
  const [chatAnswer, setChatAnswer] = useState<ChatResponse | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(() => readStoredChatMessages());
  const [personalInfo, setPersonalInfo] = useState(() => localStorage.getItem("erbollka_personal_info") ?? "");
  const [attachedPhotos, setAttachedPhotos] = useState<ChatPhoto[]>([]);
  const [aiStatus, setAiStatus] = useState<AiStatus>(idleAiStatus);
  const [isLoading, setIsLoading] = useState(false);
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
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user ?? null);
      setIsAuthReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      setIsAuthReady(true);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!user) {
      setIsCloudDataReady(false);
      return;
    }

    let cancelled = false;
    setIsCloudDataReady(false);

    loadUserDataFromSupabase(user).then((data) => {
      if (cancelled) return;
      if (data.personalInfo !== null) {
        setPersonalInfo(data.personalInfo);
      }
      if (data.messages !== null) {
        setChatMessages(data.messages);
      }
      setIsCloudDataReady(true);
    });

    return () => {
      cancelled = true;
    };
  }, [user]);

  useEffect(() => {
    fetchHistory().then(setHistory).catch(() => setHistory([]));
  }, []);

  useEffect(() => {
    localStorage.setItem("erbollka_chat_messages", JSON.stringify(chatMessages.slice(-30)));
  }, [chatMessages]);

  useEffect(() => {
    localStorage.setItem("erbollka_personal_info", personalInfo);
  }, [personalInfo]);

  useEffect(() => {
    if (!user || !isCloudDataReady) return;
    savePersonalInfoToSupabase(user.id, personalInfo);
  }, [user, isCloudDataReady, personalInfo]);

  useEffect(() => {
    if (!report) {
      setComparison(null);
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
    setChatAnswer(null);
    setHistory((items) => [demoReport, ...items.filter((item) => item.id !== demoReport.id)]);
    setPage("audits");
  }

  async function askGemini(event: { preventDefault: () => void }, mode: "chat" | "image" = "chat") {
    event.preventDefault();
    if (!question.trim()) return;
    const currentQuestion = question.trim();
    const currentPhotos = attachedPhotos;
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text: currentQuestion,
      photos: currentPhotos.map((photo) => ({
        name: photo.name,
        url: `data:${photo.mimeType};base64,${photo.data}`,
      })),
    };
    setChatMessages((items) => [...items, userMessage]);
    if (user && isCloudDataReady) {
      appendChatMessageToSupabase(user.id, userMessage);
    }
    setQuestion("");
    setAttachedPhotos([]);
    const localAnswer = buildLocalChatFallback(report, currentQuestion);
    setChatAnswer(localAnswer);
    setAiStatus({
      label: "Gemini думает",
      tone: "thinking",
      detail: report ? "Учитываю отчет, память и последние сообщения." : "Учитываю память и последние сообщения.",
    });
    setIsChatLoading(true);

    try {
      const { data, error } = await withTimeout(
        supabase.functions.invoke("ai", {
          body: {
            mode,
            system:
              "Ты Gemini-помощник для владельца fashion retail бизнеса. Отвечай по-русски структурно и практично: сначала короткий вывод, затем причины и действия. До 6 пунктов или 6 небольших абзацев. Не выдумывай цифры, явно отделяй факт от предположения.",
            prompt: buildGeneralGeminiPrompt(report, currentQuestion, personalInfo, [...chatMessages, userMessage]),
            files: currentPhotos.map(({ mimeType, data }) => ({ mimeType, data })),
          },
        }),
        mode === "image" ? 30000 : 18000,
      );
      if (error) {
        throw error;
      }
      if (typeof data?.text === "string" || typeof data?.image === "string") {
        const answer = mode === "image" ? data?.text?.trim() || "Готово." : compactAiAnswer(data.text);
        const model = typeof data?.model === "string" ? data.model : "Gemini";
        const assistantMessage: ChatMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          text: answer,
          imageUrl: typeof data?.image === "string" ? data.image : undefined,
          source: "gemini",
          model,
        };
        setChatAnswer({ answer, used_ai: true });
        setAiStatus({
          label: "Gemini ответил",
          tone: "ready",
          detail: `${model}${report ? " · учтен отчет" : " · общий режим"}${currentPhotos.length ? " · учтены фото" : ""}`,
        });
        setChatMessages((items) => [...items, assistantMessage]);
        if (user && isCloudDataReady) {
          appendChatMessageToSupabase(user.id, assistantMessage);
        }
      } else {
        throw new Error("Gemini вернул пустой ответ");
      }
    } catch {
      const assistantMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        text: localAnswer.answer,
        source: "fallback",
      };
      setAiStatus({
        label: "Локальный ответ",
        tone: "fallback",
        detail: "Gemini не ответил вовремя, показан быстрый расчет по данным отчета.",
      });
      setChatMessages((items) => [...items, assistantMessage]);
      if (user && isCloudDataReady) {
        appendChatMessageToSupabase(user.id, assistantMessage);
      }
    } finally {
      setIsChatLoading(false);
    }
  }

  function clearChat() {
    setChatMessages([]);
    setChatAnswer(null);
    setAiStatus(idleAiStatus);
    if (user && isCloudDataReady) {
      clearChatMessagesInSupabase(user.id);
    }
  }

  if (!isAuthReady) {
    return (
      <main className="landing-page">
        <div className="landing-topbar">
          <BrandLogo />
        </div>
      </main>
    );
  }

  if (!user) {
    return <LandingPage mode={authMode} setMode={setAuthMode} />;
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="header-copy">
          <BrandLogo />
          <p className="eyebrow">AI-аудит отчетов магазина</p>
          <h1>Проверка отчетов, KPI и рисков</h1>
          <p className="subtitle">
            Загружайте Excel, CSV или PDF: сервис находит ошибки, считает показатели и подсказывает, что исправить первым.
          </p>
        </div>
        <div className="header-actions">
          <div className="user-chip">
            <span>{user.user_metadata?.full_name || user.email}</span>
            <button type="button" onClick={() => supabase.auth.signOut()}>
              Выйти
            </button>
          </div>
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
        <TabButton active={page === "audits"} onClick={() => setPage("audits")} label="Аудит" />
        <TabButton active={page === "stats"} onClick={() => setPage("stats")} label="Статистика" />
        <TabButton active={page === "chat"} onClick={() => setPage("chat")} label="Чат" />
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
              history={history}
              selectReport={setReport}
            />
          ) : null}
          {page === "stats" ? <StatsPage report={report} comparison={comparison} rows={monthlyRows} /> : null}
          {page === "chat" ? (
            <ChatPage
              report={report}
              question={question}
              setQuestion={setQuestion}
              askGemini={askGemini}
              chatAnswer={chatAnswer}
              isChatLoading={isChatLoading}
              aiStatus={aiStatus}
              messages={chatMessages}
              personalInfo={personalInfo}
              setPersonalInfo={setPersonalInfo}
              attachedPhotos={attachedPhotos}
              setAttachedPhotos={setAttachedPhotos}
              clearChat={clearChat}
            />
          ) : null}
        </section>
      </section>
    </main>
  );
}

function LandingPage({ mode, setMode }: { mode: AuthMode; setMode: (mode: AuthMode) => void }) {
  return (
    <main className="landing-page">
      <header className="landing-topbar">
        <BrandLogo />
        <div className="landing-auth-actions">
          <button className={mode === "signup" ? "button" : "button secondary"} type="button" onClick={() => setMode("signup")}>
            Проверить отчет
          </button>
          <button className={mode === "signin" ? "button" : "button secondary"} type="button" onClick={() => setMode("signin")}>
            Войти
          </button>
        </div>
      </header>

      <section className="landing-hero">
        <div className="landing-copy">
          <p className="eyebrow">Для владельцев fashion retail и небольших магазинов</p>
          <h1>AI-аудитор, который проверяет отчеты магазина за вас</h1>
          <p className="subtitle">
            Загружаете Excel, CSV, PDF или фото документа. Erbollka показывает ошибки в данных, рискованные операции, KPI по продажам и короткий план действий.
          </p>
          <div className="project-summary" aria-label="Кратко о проекте">
            <span>
              <strong>Что это</strong>
              AI-кабинет для аудита отчетов магазина
            </span>
            <span>
              <strong>Что проверяет</strong>
              продажи, кассу, остатки, расходы и формулы
            </span>
            <span>
              <strong>Что дает</strong>
              список ошибок, KPI, PDF и совет Gemini
            </span>
          </div>
          <div className="hero-actions">
            <button className="button" type="button" onClick={() => setMode("signup")}>
              Проверить первый отчет
            </button>
            <button className="button secondary" type="button" onClick={() => setMode("signin")}>
              У меня уже есть вход
            </button>
          </div>
          <ul className="landing-checklist" aria-label="Что можно сделать в кабинете">
            <li>Находит пропуски, дубли, ошибки формул и подозрительные изменения.</li>
            <li>Показывает риск отчета простым языком: низкий, средний или высокий.</li>
            <li>Собирает KPI по продажам, прибыли, расходам, возвратам и скидкам.</li>
            <li>Позволяет спросить Gemini, что делать с найденными проблемами.</li>
          </ul>
          <div className="landing-points">
            <div>
              <strong>1. Загрузка</strong>
              <span>Добавьте файл отчета или откройте демо без подготовки.</span>
            </div>
            <div>
              <strong>2. Проверка</strong>
              <span>Сервис разбирает строки, показатели, аномалии и структуру.</span>
            </div>
            <div>
              <strong>3. Решение</strong>
              <span>Получите понятный список действий для владельца магазина.</span>
            </div>
          </div>
        </div>

        <AuthPanel mode={mode} setMode={setMode} />
      </section>

      <section className="landing-section demo-section">
        <div>
          <p className="eyebrow">Как это работает</p>
          <h2>Три шага вместо ручной проверки</h2>
          <div className="demo-steps">
            <article>
              <span>1</span>
              <strong>Загрузи Excel</strong>
              <p>Добавьте отчет по магазину: продажи, остатки, касса, зарплаты или KPI.</p>
            </article>
            <article>
              <span>2</span>
              <strong>ИИ анализирует отчет</strong>
              <p>Сервис сверяет структуру, формулы, аномалии, динамику и рискованные строки.</p>
            </article>
            <article>
              <span>3</span>
              <strong>Получите список ошибок</strong>
              <p>Видите причины, приоритеты и рекомендации, что исправить в первую очередь.</p>
            </article>
          </div>
        </div>
        <div className="demo-video" aria-label="30-секундное демо работы сервиса">
          <div className="video-top">
            <span />
            <span />
            <span />
          </div>
          <div className="upload-animation">
            <span className="file-icon">XLS</span>
            <div>
              <strong>Отчет_магазин_июнь.xlsx</strong>
              <small>Загрузка и анализ данных</small>
            </div>
          </div>
          <div className="scan-line" />
          <p>30-секундное демо: загрузка файла, анализ ИИ и готовый список проблем.</p>
        </div>
      </section>

      <section className="landing-section result-section">
        <div className="result-copy">
          <p className="eyebrow">Пример результата</p>
          <h2>Понятный отчет для управленческого решения</h2>
          <p className="subtitle">
            После проверки вы получаете не абстрактный текст, а список конкретных проблем, листов и действий.
          </p>
        </div>
        <div className="result-card" aria-label="Пример найденных проблем">
          <div className="result-card-head">
            <strong>Найдены проблемы</strong>
            <span>Риск: высокий</span>
          </div>
          <ul>
            <li>Несоответствие остатков на складе и в продажах</li>
            <li>Подозрительное падение продаж по категории “Платья”</li>
            <li>Ошибка в формуле листа №3, строка 48</li>
            <li>Отсутствуют данные по кассе за 12 июня</li>
          </ul>
          <div className="recommendation-preview">
            <strong>Рекомендация</strong>
            <p>Сначала проверьте кассовые данные и формулу маржи, затем сверку остатков по SKU с высокой оборачиваемостью.</p>
          </div>
        </div>
      </section>

      <section className="landing-section trust-section">
        <div>
          <p className="eyebrow">Безопасность данных</p>
          <h2>Отчеты магазина остаются конфиденциальными</h2>
        </div>
        <div className="trust-grid">
          <article>
            <strong>SSL-защита</strong>
            <span>Передача файлов защищена шифрованием.</span>
          </article>
          <article>
            <strong>Удаление файлов</strong>
            <span>Файлы удаляются через заданный срок хранения.</span>
          </article>
          <article>
            <strong>Не для обучения</strong>
            <span>Ваши Excel-файлы не используются для обучения моделей.</span>
          </article>
          <article>
            <strong>Без третьих лиц</strong>
            <span>Данные не передаются посторонним сервисам без необходимости анализа.</span>
          </article>
        </div>
      </section>

      <section className="landing-section faq-section">
        <div>
          <p className="eyebrow">FAQ</p>
          <h2>Частые вопросы перед загрузкой отчета</h2>
        </div>
        <div className="faq-grid">
          <details open>
            <summary>Какие форматы поддерживаются?</summary>
            <p>Excel XLSX, XLS, CSV, PDF, изображения, текстовые и офисные документы.</p>
          </details>
          <details>
            <summary>Где хранятся данные?</summary>
            <p>Данные привязаны к аккаунту и используются для истории проверок и работы кабинета.</p>
          </details>
          <details>
            <summary>Используются ли файлы для обучения?</summary>
            <p>Нет. Загруженные отчеты не используются для обучения AI-моделей.</p>
          </details>
          <details>
            <summary>Сколько длится анализ?</summary>
            <p>Обычно около 30 секунд. Большие файлы и PDF могут обрабатываться дольше.</p>
          </details>
          <details>
            <summary>Есть ли бесплатный тариф?</summary>
            <p>Да, можно зарегистрироваться и проверить первый отчет бесплатно.</p>
          </details>
        </div>
      </section>
    </main>
  );
}

function AuthPanel({ mode, setMode }: { mode: AuthMode; setMode: (mode: AuthMode) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [storeName, setStoreName] = useState("");
  const [message, setMessage] = useState("");
  const [isBusy, setIsBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsBusy(true);
    setMessage("");
    try {
      const result =
        mode === "signup"
          ? await supabase.auth.signUp({
              email,
              password,
              options: {
                data: {
                  full_name: fullName.trim(),
                  store_name: storeName.trim(),
                },
              },
            })
          : await supabase.auth.signInWithPassword({ email, password });

      if (result.error) {
        setMessage(result.error.message);
      } else if (mode === "signup" && !result.data.session) {
        setMessage("Аккаунт создан. Проверьте почту для подтверждения входа.");
      } else if (result.data.user) {
        await saveProfileToSupabase(result.data.user, fullName, storeName);
      }
    } catch {
      setMessage("Не удалось выполнить действие. Попробуйте еще раз.");
    } finally {
      setIsBusy(false);
    }
  }

  async function signInWithGoogle() {
    setIsBusy(true);
    setMessage("");
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: window.location.origin,
        },
      });
      if (error) {
        setMessage(error.message);
        setIsBusy(false);
      }
    } catch {
      setMessage("Не удалось открыть вход через Google. Попробуйте еще раз.");
      setIsBusy(false);
    }
  }

  return (
    <section className="auth-panel">
      <div>
        <p className="eyebrow">{mode === "signin" ? "Вход" : "Регистрация"}</p>
        <h2>{mode === "signin" ? "Войти в кабинет" : "Создать аккаунт"}</h2>
      </div>
      <button className="google-auth-button" type="button" onClick={signInWithGoogle} disabled={isBusy}>
        <span aria-hidden="true">G</span>
        {isBusy ? "Подождите..." : mode === "signin" ? "Войти с Google" : "Зарегистрироваться с Google"}
      </button>
      <div className="auth-divider">
        <span>или</span>
      </div>
      <form className="form" onSubmit={onSubmit}>
        {mode === "signup" ? (
          <>
            <label>
              Имя
              <input value={fullName} onChange={(event) => setFullName(event.target.value)} placeholder="Альмира" />
            </label>
            <label>
              Магазин
              <input value={storeName} onChange={(event) => setStoreName(event.target.value)} placeholder="Название магазина" />
            </label>
          </>
        ) : null}
        <label>
          Email
          <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@email.com" required />
        </label>
        <label>
          Пароль
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Минимум 6 символов"
            minLength={6}
            required
          />
        </label>
        {message ? <p className="error">{message}</p> : null}
        <button className="button" disabled={isBusy}>
          {isBusy ? "Подождите..." : mode === "signin" ? "Войти" : "Зарегистрироваться"}
        </button>
      </form>
      <button className="auth-switch" type="button" onClick={() => setMode(mode === "signin" ? "signup" : "signin")}>
        {mode === "signin" ? "Нет аккаунта? Зарегистрироваться" : "Уже есть аккаунт? Войти"}
      </button>
    </section>
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
          {mainKpiKeys.map((key) => (
            <KpiBar key={key} label={kpiLabels[key]} value={Number(totals[key] ?? 0)} max={maxKpi(totals)} />
          ))}
        </div>
      </section>
    </div>
  );
}

function AuditsPage({
  report,
  isDemoReport,
  history,
  selectReport,
}: {
  report: AuditReport | null;
  isDemoReport: boolean;
  history: AuditReport[];
  selectReport: (report: AuditReport) => void;
}) {
  const [selectedFinding, setSelectedFinding] = useState<Finding | null>(null);
  const [historySearch, setHistorySearch] = useState("");
  const [riskFilter, setRiskFilter] = useState<HistoryRiskFilter>("all");
  const visibleFindings = useMemo(() => prioritizeFindings(report?.findings ?? []).slice(0, visibleFindingsLimit), [report]);
  const ownerSummary = useMemo(() => buildOwnerSummary(report), [report]);
  const filteredHistory = useMemo(
    () => filterHistory(history, historySearch, riskFilter),
    [history, historySearch, riskFilter],
  );

  useEffect(() => {
    setSelectedFinding(visibleFindings[0] ?? null);
  }, [report?.id, visibleFindings]);

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
            <div className="owner-brief">
              <div className="panel-head compact-head">
                <h2>Вывод для владельца</h2>
                <span className="soft-pill">{riskLabel[report.risk_level] ?? report.risk_level}</span>
              </div>
              <div className="owner-brief-grid">
                {ownerSummary.map((item) => (
                  <div className="owner-brief-item" key={item.title}>
                    <strong>{item.title}</strong>
                    <p>{item.text}</p>
                  </div>
                ))}
              </div>
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
          <h2>Главные проблемы</h2>
          {report?.findings.length ? (
            <span className="soft-pill">
              {visibleFindings.length} из {report.findings.length}
            </span>
          ) : null}
        </div>
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
              {visibleFindings.map((finding, index) => (
                <tr
                  className="clickable-row"
                  key={`${finding.code}-${index}`}
                  onClick={() => setSelectedFinding(finding)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelectedFinding(finding);
                    }
                  }}
                  tabIndex={0}
                  role="button"
                  aria-label={`Открыть проблему: ${finding.title}`}
                >
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
        <div className="finding-cards">
          {visibleFindings.map((finding, index) => (
            <button
              className="finding-card"
              type="button"
              key={`${finding.code}-card-${index}`}
              onClick={() => setSelectedFinding(finding)}
            >
              <span>{severityLabel[finding.severity]}</span>
              <strong>{finding.title}</strong>
              <small>
                {finding.sheet_name}
                {finding.cell ? `, ${finding.cell}` : ""}
              </small>
            </button>
          ))}
          {!report?.findings.length ? <p className="muted">Пока нет данных аудита.</p> : null}
        </div>
        {selectedFinding ? (
          <div className="finding-detail">
            <strong>{selectedFinding.title}</strong>
            <span>
              {selectedFinding.sheet_name}
              {selectedFinding.cell ? `, ${selectedFinding.cell}` : ""}
            </span>
            <p>{selectedFinding.description}</p>
            <p>{selectedFinding.suggested_fix}</p>
          </div>
        ) : null}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>История документов</h2>
          <span className="soft-pill">{filteredHistory.length} из {history.length}</span>
        </div>
        <div className="history-filters">
          <input
            value={historySearch}
            onChange={(event) => setHistorySearch(event.target.value)}
            placeholder="Поиск по файлу"
          />
          <select value={riskFilter} onChange={(event) => setRiskFilter(event.target.value as HistoryRiskFilter)}>
            <option value="all">Все риски</option>
            <option value="high">Высокий</option>
            <option value="medium">Средний</option>
            <option value="low">Низкий</option>
          </select>
        </div>
        <div className="history-list">
          {filteredHistory.map((item) => (
            <button className="history-item" type="button" key={item.id} onClick={() => selectReport(item)}>
              <span>{item.file_name}</span>
              <small>
                {new Date(item.created_at).toLocaleDateString("ru-RU")} · {riskLabel[item.risk_level] ?? item.risk_level}
              </small>
            </button>
          ))}
          {history.length && !filteredHistory.length ? <p className="muted">По этим фильтрам ничего не найдено.</p> : null}
          {!history.length ? <p className="muted">История появится после первой проверки.</p> : null}
        </div>
      </section>
    </div>
  );
}

function ChatPage({
  report,
  question,
  setQuestion,
  askGemini,
  chatAnswer,
  isChatLoading,
  aiStatus,
  messages,
  personalInfo,
  setPersonalInfo,
  attachedPhotos,
  setAttachedPhotos,
  clearChat,
}: {
  report: AuditReport | null;
  question: string;
  setQuestion: (value: string) => void;
  askGemini: (event: { preventDefault: () => void }, mode?: "chat" | "image") => void;
  chatAnswer: ChatResponse | null;
  isChatLoading: boolean;
  aiStatus: AiStatus;
  messages: ChatMessage[];
  personalInfo: string;
  setPersonalInfo: (value: string) => void;
  attachedPhotos: ChatPhoto[];
  setAttachedPhotos: (value: ChatPhoto[]) => void;
  clearChat: () => void;
}) {
  const [isToolsOpen, setIsToolsOpen] = useState(false);

  async function onPhotoChange(files: FileList | null) {
    if (!files?.length) return;
    const photos = await Promise.all(Array.from(files).slice(0, 3).map(fileToChatPhoto));
    setAttachedPhotos([...attachedPhotos, ...photos].slice(0, 3));
    setIsToolsOpen(false);
  }

  return (
    <div className="chat-home">
      <section className="chat-panel">
        <div className="chat-hero">
          <div>
            <p className="eyebrow">Gemini AI</p>
            <h2>Чем помочь?</h2>
          </div>
          <div className="chat-hero-actions">
            <span className="soft-pill">{report ? "Есть контекст отчета" : "Общий режим"}</span>
            <button className="new-chat-button" type="button" onClick={clearChat} aria-label="Новый чат" title="Новый чат">
              <span className="new-chat-icon" aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className={`ai-status ${aiStatus.tone}`}>
          <strong>{isChatLoading ? "Gemini думает" : aiStatus.label}</strong>
          <span>{aiStatus.detail}</span>
        </div>

        <div className="chat-thread">
          {messages.map((message) => (
            <div className={message.role === "user" ? "chat-bubble user" : "chat-bubble assistant"} key={message.id}>
              <span>
                {message.role === "user"
                  ? "Вы"
                  : message.source === "fallback"
                    ? "Локальный ответ"
                    : message.model || "Gemini"}
              </span>
              <p>{message.text}</p>
              {message.photos?.length ? (
                <div className="chat-photo-grid">
                  {message.photos.map((photo) => (
                    <img src={photo.url} alt={photo.name} key={photo.url} />
                  ))}
                </div>
              ) : null}
              {message.imageUrl ? <img className="generated-image" src={message.imageUrl} alt="Сгенерированное Gemini изображение" /> : null}
            </div>
          ))}
          {!messages.length ? (
            <div className="chat-empty">
              <strong>Спросите про отчет, продажи, идеи или фото</strong>
              <span>Enter отправляет сообщение. Shift+Enter переносит строку.</span>
            </div>
          ) : null}
        </div>

        {attachedPhotos.length ? (
          <div className="attached-photos">
            {attachedPhotos.map((photo) => (
              <span key={`${photo.name}-${photo.data.slice(0, 12)}`}>{photo.name}</span>
            ))}
          </div>
        ) : null}

        <div className="prompt-templates" aria-label="Шаблоны вопросов">
          {chatPromptTemplates.map((template) => (
            <button
              type="button"
              key={template}
              onClick={() => setQuestion(template)}
              disabled={isChatLoading}
            >
              {template}
            </button>
          ))}
        </div>

        <form className="chat-composer" onSubmit={(event) => askGemini(event, "chat")}>
          <textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (!isChatLoading && question.trim()) {
                  askGemini(event, "chat");
                }
              }
            }}
            placeholder="Спросите Gemini..."
            rows={1}
          />
          <div className="composer-actions">
            <div className="composer-tools">
              <button
                className="plus-button"
                type="button"
                aria-label="Открыть функции"
                aria-expanded={isToolsOpen}
                onClick={() => setIsToolsOpen((value) => !value)}
              >
                +
              </button>
              {isToolsOpen ? (
                <div className="tools-menu">
                  <label className="tools-menu-item">
                    Фото
                    <input type="file" accept="image/*" multiple onChange={(event) => onPhotoChange(event.target.files)} />
                  </label>
                  <button
                    className="tools-menu-item"
                    disabled={isChatLoading || !question.trim()}
                    type="button"
                    onClick={(event) => {
                      setIsToolsOpen(false);
                      askGemini(event, "image");
                    }}
                  >
                    Фото AI
                  </button>
                </div>
              ) : null}
            </div>
            <button className="send-button" disabled={isChatLoading || !question.trim()} aria-label="Отправить">
              {isChatLoading ? "..." : "↑"}
            </button>
          </div>
        </form>

        <label className="memory-box compact-memory">
          <span>Память</span>
          <textarea
            value={personalInfo}
            onChange={(event) => setPersonalInfo(event.target.value)}
            placeholder="Имя, магазин, город, стиль ответа..."
          />
        </label>

        {chatAnswer ? (
          <div className="chat-answer">
            <span>{chatAnswer.used_ai ? "Gemini" : "Ожидание Gemini"}</span>
            <p>{chatAnswer.answer}</p>
          </div>
        ) : (
          <p className="muted">Этот чат не привязан к документам. Если отчет загружен, Gemini может учитывать его, но отвечать будет на любые вопросы.</p>
        )}
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
  return `${new Intl.NumberFormat("kk-KZ", { maximumFractionDigits: 0 }).format(value)} ₸`;
}

function formatNumber(value: number) {
  return Math.abs(value) >= 1000 ? formatMoney(value) : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(value);
}

function buildOwnerSummary(report: AuditReport | null) {
  if (!report) return [];
  const totals = report.workbook_profile?.metric_totals ?? {};
  const topFinding = prioritizeFindings(report.findings)[0];
  const sales = Number(totals.sales ?? 0);
  const profit = Number(totals.profit ?? 0);
  const expense = Number(totals.expense ?? 0);
  const returnValue = Number(totals.return ?? 0);
  const quality = report.workbook_profile?.quality_score ?? Math.max(0, 100 - report.risk_score);

  return [
    {
      title: "Сегодня",
      text: topFinding
        ? `Сначала проверьте: ${topFinding.title}. ${topFinding.suggested_fix}`
        : "Критичных замечаний не видно. Можно переходить к плановым проверкам продаж и расходов.",
    },
    {
      title: "Финансы",
      text: `Продажи ${formatMoney(sales)}, прибыль ${formatMoney(profit)}, расходы ${formatMoney(expense)}, возвраты ${formatMoney(returnValue)}.`,
    },
    {
      title: "Контроль",
      text: `Качество отчета ${quality}/100, риск: ${riskLabel[report.risk_level] ?? report.risk_level}, замечаний: ${report.total_findings}.`,
    },
  ];
}

function filterHistory(history: AuditReport[], search: string, riskFilter: HistoryRiskFilter) {
  const query = search.trim().toLowerCase();
  return history.filter((item) => {
    const matchesSearch = !query || item.file_name.toLowerCase().includes(query);
    const risk = item.risk_level.toLowerCase();
    const matchesRisk =
      riskFilter === "all" ||
      (riskFilter === "high" && ["high", "critical"].includes(risk)) ||
      (riskFilter === "medium" && risk === "medium") ||
      (riskFilter === "low" && ["low", "info"].includes(risk));
    return matchesSearch && matchesRisk;
  });
}

function buildLocalChatFallback(report: AuditReport | null, question: string): ChatResponse {
  if (!report) {
    return {
      used_ai: false,
      answer: "Жду Gemini. Если ответа нет, проверьте Edge Function и ключ Gemini.",
    };
  }

  const totals = report.workbook_profile?.metric_totals ?? {};
  const topFindings = prioritizeFindings(report.findings);
  return {
    used_ai: false,
    answer: [
      `Риск: ${riskLabel[report.risk_level] ?? report.risk_level}. Замечаний: ${report.total_findings}.`,
      `Продажи: ${formatMoney(Number(totals.sales ?? 0))}. Прибыль: ${formatMoney(Number(totals.profit ?? 0))}. Расходы: ${formatMoney(Number(totals.expense ?? 0))}.`,
      topFindings[0] ? `Сначала проверьте: ${topFindings[0].title}. ${topFindings[0].suggested_fix}` : "Серьезных замечаний нет.",
      `Вопрос: ${question}`,
    ].join(" "),
  };
}

function buildGeneralGeminiPrompt(report: AuditReport | null, question: string, personalInfo = "", messages: ChatMessage[] = []) {
  const memory = personalInfo.trim() ? `Память о пользователе:\n${personalInfo.trim()}` : "";
  const recentMessages = messages.slice(-8).map((item) => `${item.role === "user" ? "Пользователь" : "Gemini"}: ${item.text}`).join("\n");
  const history = recentMessages ? `Последняя переписка:\n${recentMessages}` : "";

  if (!report) {
    return [
      memory,
      history,
      `Вопрос пользователя: ${question}`,
      "Режим ответа: дай полезный ответ для владельца магазина. Если вопрос не про магазин, все равно отвечай понятно и прикладно.",
      "Формат: короткий вывод, затем 3-6 конкретных пунктов. Если даешь план, укажи первый шаг.",
    ].filter(Boolean).join("\n\n");
  }

  const ownerSummary = buildOwnerSummary(report);
  const reportContext = {
    question,
    file_name: report.file_name,
    risk_score: report.risk_score,
    risk_level: report.risk_level,
    summary: report.summary,
    recommendations: report.recommendations,
    owner_summary: ownerSummary,
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
  return [
    memory,
    history,
    `Вопрос пользователя: ${question}`,
    "Режим ответа: ты помощник владельца fashion retail магазина. Дай сначала главный вывод, затем 3-6 конкретных пунктов: причина, риск или действие.",
    "Если используешь данные отчета, опирайся только на контекст ниже. Если данных не хватает, так и скажи и предложи, что загрузить или проверить.",
    "Ниже есть дополнительный контекст загруженного отчета. Используй его только если он реально помогает ответу.",
    JSON.stringify(reportContext, null, 2),
  ].filter(Boolean).join("\n\n");
}

function compactAiAnswer(text: string) {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const compact = (lines.length > 1 ? lines.slice(0, 6).join("\n") : text.trim()).slice(0, 1200);
  return compact.length < text.trim().length ? `${compact.replace(/[.,;:\s]+$/, "")}...` : compact;
}

function readStoredChatMessages(): ChatMessage[] {
  try {
    const value = localStorage.getItem("erbollka_chat_messages");
    const parsed = value ? JSON.parse(value) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function fileToChatPhoto(file: File): Promise<ChatPhoto> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result ?? "");
      resolve({
        name: file.name,
        mimeType: file.type || "image/png",
        data: value.includes(",") ? value.split(",")[1] : value,
      });
    };
    reader.onerror = () => reject(new Error("Не удалось прочитать фото"));
    reader.readAsDataURL(file);
  });
}

async function loadUserDataFromSupabase(user: User): Promise<{ personalInfo: string | null; messages: ChatMessage[] | null }> {
  await saveProfileToSupabase(
    user,
    typeof user.user_metadata?.full_name === "string" ? user.user_metadata.full_name : "",
    typeof user.user_metadata?.store_name === "string" ? user.user_metadata.store_name : "",
  );

  const [memoryResult, messagesResult] = await Promise.all([
    supabase.from("ai_memories").select("personal_info").eq("user_id", user.id).maybeSingle(),
    supabase
      .from("chat_messages")
      .select("id, role, text, image_url, photos, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: true })
      .limit(30),
  ]);

  return {
    personalInfo: memoryResult.error ? null : memoryResult.data?.personal_info ?? "",
    messages: messagesResult.error
      ? null
      : (messagesResult.data ?? []).map((item) => ({
          id: String(item.id),
          role: item.role === "user" ? "user" : "assistant",
          text: String(item.text ?? ""),
          imageUrl: typeof item.image_url === "string" ? item.image_url : undefined,
          photos: readStoredPhotos(item.photos),
          source: readStoredMessageMeta(item.photos).source,
          model: readStoredMessageMeta(item.photos).model,
        })),
  };
}

async function saveProfileToSupabase(user: User, fullName = "", storeName = "") {
  await supabase.from("profiles").upsert({
    user_id: user.id,
    email: user.email ?? "",
    full_name: fullName || user.user_metadata?.full_name || null,
    store_name: storeName || user.user_metadata?.store_name || null,
    updated_at: new Date().toISOString(),
  });
}

async function savePersonalInfoToSupabase(userId: string, personalInfo: string) {
  await supabase.from("ai_memories").upsert({
    user_id: userId,
    personal_info: personalInfo,
    updated_at: new Date().toISOString(),
  });
}

async function appendChatMessageToSupabase(userId: string, message: ChatMessage) {
  await supabase.from("chat_messages").insert({
    id: message.id,
    user_id: userId,
    role: message.role,
    text: message.text,
    image_url: message.imageUrl ?? null,
    photos: {
      items: message.photos ?? [],
      meta: {
        source: message.source,
        model: message.model,
      },
    },
    created_at: new Date().toISOString(),
  });
  await trimStoredChatMessages(userId);
}

async function trimStoredChatMessages(userId: string) {
  const { data } = await supabase
    .from("chat_messages")
    .select("id")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .range(30, 1000);

  const ids = (data ?? []).map((item) => String(item.id));
  if (ids.length) {
    await supabase.from("chat_messages").delete().eq("user_id", userId).in("id", ids);
  }
}

async function clearChatMessagesInSupabase(userId: string) {
  await supabase.from("chat_messages").delete().eq("user_id", userId);
}

function readStoredPhotos(value: unknown): Array<{ name: string; url: string }> {
  if (Array.isArray(value)) return value as Array<{ name: string; url: string }>;
  if (value && typeof value === "object" && "items" in value && Array.isArray((value as { items?: unknown }).items)) {
    return (value as { items: Array<{ name: string; url: string }> }).items;
  }
  return [];
}

function readStoredMessageMeta(value: unknown): Pick<ChatMessage, "source" | "model"> {
  if (!value || typeof value !== "object" || !("meta" in value)) return {};
  const meta = (value as { meta?: { source?: unknown; model?: unknown } }).meta;
  return {
    source: meta?.source === "gemini" || meta?.source === "fallback" ? meta.source : undefined,
    model: typeof meta?.model === "string" ? meta.model : undefined,
  };
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

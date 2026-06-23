import { FormEvent, MutableRefObject, useEffect, useMemo, useRef, useState } from "react";
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
import { supabase } from "./lib/supabase";
import "./index.css";

type Page = "overview" | "reports" | "inventory" | "risk" | "insights" | "analytics" | "settings";
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
  info: "Info",
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

const riskLabel: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
  info: "Info",
};

const kpiLabels: Record<string, string> = {
  sales: "Sales",
  profit: "Profit",
  salary: "Payroll",
  bonus: "Bonus",
  expense: "Expenses",
  discount: "Discounts",
  return: "Returns",
};

const mainKpiKeys = ["sales", "profit", "expense", "return"];
const visibleFindingsLimit = 5;
const chatPromptTemplates = [
  "Summarize report",
  "Find inventory risks",
  "Explain revenue drop",
  "Create action plan",
];
const idleAiStatus: AiStatus = {
  label: "Aura AI ready",
  tone: "idle",
  detail: "Ask about uploaded reports, inventory risk, revenue changes, or executive summaries.",
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
  const [page, setPage] = useState<Page>("overview");
  const [file, setFile] = useState<File | null>(null);
  const [activeReportFile, setActiveReportFile] = useState<File | null>(null);
  const [documentContext, setDocumentContext] = useState("");
  const [storeId, setStoreId] = useState("00000000-0000-0000-0000-000000000001");
  const [periodMonth, setPeriodMonth] = useState("2026-06");
  const [report, setReport] = useState<AuditReport | null>(null);
  const [comparison, setComparison] = useState<ReportComparison | null>(null);
  const [history, setHistory] = useState<AuditReport[]>([]);
  const [question, setQuestion] = useState("Summarize the current retail report and list the first actions.");
  const [chatAnswer, setChatAnswer] = useState<ChatResponse | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(() => readStoredChatMessages());
  const [personalInfo, setPersonalInfo] = useState(() => localStorage.getItem("erbollka_personal_info") ?? "");
  const [attachedPhotos, setAttachedPhotos] = useState<ChatPhoto[]>([]);
  const [aiStatus, setAiStatus] = useState<AiStatus>(idleAiStatus);
  const [isLoading, setIsLoading] = useState(false);
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const totals = report?.workbook_profile?.metric_totals ?? {};
  const qualityScore = report?.workbook_profile?.quality_score ?? (report ? Math.max(0, 100 - report.risk_score) : null);
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
    fetchComparison(report.id).then(setComparison).catch(() => setComparison(null));
  }, [report]);

  const monthlyRows = useMemo(() => buildMonthlyRows(history, report), [history, report]);

  function selectReportFromHistory(item: AuditReport) {
    setReport(item);
    setActiveReportFile(null);
    setDocumentContext("");
    setChatAnswer(null);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) {
      setError("Choose a retail report first: XLSX, CSV, PDF, image, or office document.");
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const result = await uploadAudit(file, storeId, periodMonth);
      const { extractDocumentContext } = await import("./lib/clientAudit");
      const extractedContext = await extractDocumentContext(file).catch(() => "");
      setReport(result);
      setActiveReportFile(file);
      setDocumentContext(extractedContext);
      setHistory((items) => [result, ...items.filter((item) => item.id !== result.id)]);
      setChatAnswer(null);
      setPage("risk");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not analyze the document.");
    } finally {
      setIsLoading(false);
    }
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
      label: "Aura AI is thinking",
      tone: "thinking",
      detail: report ? "Using report context, memory, and recent messages." : "Using memory and recent messages.",
    });
    setIsChatLoading(true);

    try {
      const documentFile = activeReportFile && shouldAttachFileToGemini(activeReportFile) ? await fileToAiPart(activeReportFile).catch(() => null) : null;
      const { data, error } = await withTimeout(
        supabase.functions.invoke("ai", {
          body: {
            mode,
            system:
              "You are Gemini in AuraRetail. Answer any user question helpfully. If a retail document/report is provided, use it when relevant and cite what you found in it. If the question is unrelated to the document, answer normally. Do not claim you read data that is not present.",
            prompt: buildGeneralGeminiPrompt(report, currentQuestion, personalInfo, [...chatMessages, userMessage], documentContext),
            files: [
              ...(documentFile ? [documentFile] : []),
              ...currentPhotos.map(({ mimeType, data }) => ({ mimeType, data })),
            ],
          },
        }),
        documentFile || documentContext ? 45000 : mode === "image" ? 30000 : 22000,
      );
      if (error) {
        throw error;
      }
      if (typeof data?.text === "string" || typeof data?.image === "string") {
        const answer = mode === "image" ? data?.text?.trim() || "Done." : compactAiAnswer(data.text);
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
          label: "Aura AI answered",
          tone: "ready",
          detail: `${model}${report ? " with report context" : " in general mode"}${currentPhotos.length ? " and photos" : ""}`,
        });
        setChatMessages((items) => [...items, assistantMessage]);
        if (user && isCloudDataReady) {
          appendChatMessageToSupabase(user.id, assistantMessage);
        }
      } else {
        throw new Error("Gemini returned an empty response");
      }
    } catch {
      const assistantMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        text: localAnswer.answer,
        source: "fallback",
      };
      setAiStatus({
        label: "Local fallback",
        tone: "fallback",
        detail: "Gemini did not answer in time, so Aura generated a quick report-based fallback.",
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

  const uploadProps = {
    file,
    setFile,
    storeId,
    setStoreId,
    periodMonth,
    setPeriodMonth,
    onSubmit,
    isLoading,
    error,
  };

  if (!isAuthReady) {
    return (
      <main className="loading-screen">
        <div className="loading-card">
          <AuraLogo />
          <span className="loading-line" />
        </div>
      </main>
    );
  }

  if (!user) {
    return <LandingPage mode={authMode} setMode={setAuthMode} />;
  }

  return (
    <main className="dashboard-shell">
      <Sidebar page={page} setPage={setPage} />
      <section className="dashboard-main">
        <TopBar user={user} setPage={setPage} report={report} />
        <div className="dashboard-content">
          {page === "overview" ? (
            <OverviewPage
              report={report}
              totals={totals}
              qualityScore={qualityScore}
              highRiskCount={highRiskCount}
              fraudCount={fraudCount}
              uploadProps={uploadProps}
              setPage={setPage}
            />
          ) : null}
          {page === "reports" ? <ReportsPage uploadProps={uploadProps} report={report} history={history} selectReport={selectReportFromHistory} documentContext={documentContext} activeReportFile={activeReportFile} /> : null}
          {page === "inventory" ? <InventoryPage report={report} totals={totals} /> : null}
          {page === "risk" ? (
            <RiskAuditPage report={report} history={history} selectReport={selectReportFromHistory} />
          ) : null}
          {page === "insights" ? <InsightsPage report={report} setPage={setPage} /> : null}
          {page === "analytics" ? <AnalyticsPage report={report} comparison={comparison} rows={monthlyRows} /> : null}
          {page === "settings" ? (
            <SettingsPage personalInfo={personalInfo} setPersonalInfo={setPersonalInfo} user={user} />
          ) : null}
        </div>
      </section>
      <AIChat
        report={report}
        question={question}
        setQuestion={setQuestion}
        askGemini={askGemini}
        chatAnswer={chatAnswer}
        isChatLoading={isChatLoading}
        aiStatus={aiStatus}
        messages={chatMessages}
        attachedPhotos={attachedPhotos}
        setAttachedPhotos={setAttachedPhotos}
        clearChat={clearChat}
        documentContext={documentContext}
        activeReportFile={activeReportFile}
      />
    </main>
  );
}

function AuraLogo() {
  return (
    <div className="aura-logo" aria-label="AuraRetail">
      <span className="aura-mark">A</span>
      <span>
        <strong>AuraRetail</strong>
        <small>AI audit analytics</small>
      </span>
    </div>
  );
}

function GoogleLogo() {
  return (
    <svg aria-hidden="true" className="google-logo" viewBox="0 0 24 24" focusable="false">
      <path
        fill="#4285F4"
        d="M23.52 12.27c0-.82-.07-1.6-.2-2.36H12v4.47h6.47a5.53 5.53 0 0 1-2.4 3.63v2.96h3.89c2.27-2.1 3.56-5.18 3.56-8.7z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.07 7.95-2.93l-3.89-2.96c-1.08.72-2.45 1.14-4.06 1.14-3.12 0-5.76-2.1-6.7-4.93H1.3v3.05A12 12 0 0 0 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.3 14.32A7.2 7.2 0 0 1 4.93 12c0-.81.13-1.6.37-2.32V6.63H1.3A12 12 0 0 0 0 12c0 1.93.46 3.75 1.3 5.37l4-3.05z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.76 0 3.34.61 4.59 1.8l3.44-3.44A11.55 11.55 0 0 0 12 0 12 12 0 0 0 1.3 6.63l4 3.05C6.24 6.85 8.88 4.75 12 4.75z"
      />
    </svg>
  );
}

function LandingPage({ mode, setMode }: { mode: AuthMode; setMode: (mode: AuthMode) => void }) {
  const loginRef = useRef<HTMLElement | null>(null);

  function openAuth(targetMode: AuthMode) {
    setMode(targetMode);
    window.setTimeout(() => {
      loginRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 0);
  }

  return (
    <main className="landing-page">
      <header className="landing-topbar">
        <AuraLogo />
        <div className="landing-auth-actions">
          <button className="button ghost" type="button" onClick={() => openAuth("signin")}>
            Sign in
          </button>
          <button className="button" type="button" onClick={() => openAuth("signup")}>
            Get Started
          </button>
        </div>
      </header>

      <section className="landing-hero">
        <div className="hero-copy">
          <span className="eyebrow">AI-powered retail audit and analytics dashboard</span>
          <h1>AI Retail Auditor: Precision Intelligence for Every Store.</h1>
          <p className="subtitle">
            Upload retail reports, audit inventory performance, detect risks, and get AI-powered recommendations instantly.
          </p>
          <div className="hero-actions">
            <button className="button button-lg" type="button" onClick={() => openAuth("signup")}>
              Get Started
            </button>
            <button className="button secondary button-lg" type="button" onClick={() => openAuth("signin")}>
              Sign in
            </button>
          </div>
          <UploadMockup />
          <div className="value-grid">
            <ValueCard title="Real-time Auditing" text="Parse files, surface anomalies, and prioritize what matters first." />
            <ValueCard title="Risk Prioritization" text="Rank inventory, POS, margin, and promotion issues by impact." />
            <ValueCard title="Executive Summary AI" text="Turn noisy reports into board-ready actions in seconds." />
            <ValueCard title="Inventory Insights" text="Understand SKU movement, duplication, and stock variance." />
          </div>
        </div>
        <div className="landing-side">
          <ReportPreview />
          <LoginPage mode={mode} setMode={setMode} refTarget={loginRef} />
        </div>
      </section>
    </main>
  );
}

function UploadMockup() {
  return (
    <div className="landing-upload">
      <div className="upload-icon">UP</div>
      <strong>Drop your retail reports here</strong>
      <span>Supports CSV, XLSX, PDF reports</span>
      <button className="button secondary" type="button">
        Upload File
      </button>
    </div>
  );
}

function ReportPreview() {
  return (
    <div className="report-preview">
      <div className="preview-head">
        <span>Upload preview</span>
        <strong>Ready</strong>
      </div>
      <div className="mock-chart">
        {[34, 48, 28, 58, 42, 64].map((height, index) => (
          <span style={{ height: `${height}%` }} key={index} />
        ))}
      </div>
      <div className="preview-row">
        <span>Data source</span>
        <strong>Your file</strong>
      </div>
      <div className="preview-row warning">
        <span>AI status</span>
        <strong>Waiting</strong>
      </div>
    </div>
  );
}

function ValueCard({ title, text }: { title: string; text: string }) {
  return (
    <article className="value-card">
      <span className="card-dot" />
      <strong>{title}</strong>
      <p>{text}</p>
    </article>
  );
}

function LoginPage({
  mode,
  setMode,
  refTarget,
}: {
  mode: AuthMode;
  setMode: (mode: AuthMode) => void;
  refTarget?: MutableRefObject<HTMLElement | null>;
}) {
  return (
    <section className="login-shell" ref={refTarget}>
      <div className="login-gradient">
        <span className="eyebrow">Enterprise intelligence</span>
        <h2>Transforming Retail Intelligence.</h2>
        <p>Audit faster, recover revenue, and make every store decision data-driven.</p>
        <div className="login-stats">
          <strong>Document-aware chat</strong>
          <strong>Real file analysis</strong>
        </div>
      </div>
      <AuthPanel mode={mode} setMode={setMode} />
    </section>
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
        setMessage("Account created. Check your email to confirm sign in.");
      } else if (result.data.user) {
        await saveProfileToSupabase(result.data.user, fullName, storeName);
      }
    } catch {
      setMessage("Could not complete the action. Please try again.");
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
      setMessage("Could not open Google sign in. Please try again.");
      setIsBusy(false);
    }
  }

  return (
    <section className="auth-panel">
      <div>
        <p className="eyebrow">{mode === "signin" ? "Secure login" : "Start free"}</p>
        <h2>Welcome back</h2>
      </div>
      <button className="google-auth-button" type="button" onClick={signInWithGoogle} disabled={isBusy}>
        <GoogleLogo />
        {mode === "signin" ? "Sign in with Google" : "Sign up with Google"}
      </button>
      <button
        className="google-auth-button microsoft"
        type="button"
        onClick={() => setMessage("Microsoft SSO can be connected in Supabase when the provider is enabled.")}
        disabled={isBusy}
      >
        <span className="microsoft-logo">M</span>
        Sign in with Microsoft
      </button>
      <div className="auth-divider">
        <span>or</span>
      </div>
      <form className="form" onSubmit={onSubmit}>
        {mode === "signup" ? (
          <>
            <label>
              Full name
              <input value={fullName} onChange={(event) => setFullName(event.target.value)} placeholder="Almira" />
            </label>
            <label>
              Store name
              <input value={storeName} onChange={(event) => setStoreName(event.target.value)} placeholder="Aura Store" />
            </label>
          </>
        ) : null}
        <label>
          Email
          <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@company.com" required />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Minimum 6 characters"
            minLength={6}
            required
          />
        </label>
        {message ? <p className="error">{message}</p> : null}
        <button className="button full" disabled={isBusy}>
          {isBusy ? "Please wait..." : mode === "signin" ? "Sign in to dashboard" : "Create dashboard account"}
        </button>
      </form>
      <button className="auth-switch" type="button" onClick={() => setMode(mode === "signin" ? "signup" : "signin")}>
        {mode === "signin" ? "Create an account" : "Already have an account? Sign in"}
      </button>
      <button className="auth-switch subtle" type="button" onClick={() => setMessage("Sign in to open the dashboard and upload real reports.")}>
        Continue without account
      </button>
    </section>
  );
}

function Sidebar({ page, setPage }: { page: Page; setPage: (page: Page) => void }) {
  const items: Array<{ page: Page; label: string; icon: string }> = [
    { page: "overview", label: "Overview", icon: "OV" },
    { page: "reports", label: "Reports", icon: "RP" },
    { page: "inventory", label: "Inventory", icon: "IN" },
    { page: "risk", label: "Risk Audit", icon: "RA" },
    { page: "insights", label: "AI Insights", icon: "AI" },
    { page: "analytics", label: "Analytics", icon: "AN" },
    { page: "settings", label: "Settings", icon: "ST" },
  ];

  return (
    <aside className="sidebar">
      <AuraLogo />
      <nav className="sidebar-nav" aria-label="Dashboard navigation">
        {items.map((item) => (
          <button
            className={page === item.page ? "nav-item active" : "nav-item"}
            type="button"
            onClick={() => setPage(item.page)}
            key={item.page}
          >
            <span>{item.icon}</span>
            {item.label}
          </button>
        ))}
      </nav>
      <div className="sidebar-help">
        <strong>Need help?</strong>
        <p>Ask Aura AI to analyze your data.</p>
        <button className="button secondary full" type="button" onClick={() => setPage("reports")}>
          New Analysis
        </button>
      </div>
    </aside>
  );
}

function TopBar({
  user,
  setPage,
  report,
}: {
  user: User;
  setPage: (page: Page) => void;
  report: AuditReport | null;
}) {
  const displayName = user.user_metadata?.full_name || user.email || "Director";
  return (
    <header className="topbar">
      <div className="search-box">
        <span>Search</span>
        <input placeholder="Search reports, SKUs, risks..." />
      </div>
      <div className="topbar-actions">
        {report ? (
          <a className="button secondary" href={pdfUrl(report.id)} target="_blank" rel="noreferrer">
            PDF
          </a>
        ) : null}
        <button className="button" type="button" onClick={() => setPage("reports")}>
          Upload Report
        </button>
        <div className="user-menu">
          <span>{String(displayName).slice(0, 1).toUpperCase()}</span>
          <div>
            <strong>{displayName}</strong>
            <button type="button" onClick={() => supabase.auth.signOut()}>
              Sign out
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}

type UploadProps = {
  file: File | null;
  setFile: (file: File | null) => void;
  storeId: string;
  setStoreId: (value: string) => void;
  periodMonth: string;
  setPeriodMonth: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  isLoading: boolean;
  error: string | null;
};

function OverviewPage({
  report,
  totals,
  qualityScore,
  highRiskCount,
  fraudCount,
  uploadProps,
  setPage,
}: {
  report: AuditReport | null;
  totals: Record<string, number>;
  qualityScore: number | null;
  highRiskCount: number;
  fraudCount: number;
  uploadProps: UploadProps;
  setPage: (page: Page) => void;
}) {
  const recovered = report ? Math.abs(Number(totals.profit ?? 0)) * 0.08 : null;
  return (
    <div className="page-stack">
      <section className="welcome-panel">
        <div>
          <span className="eyebrow">AuraRetail control room</span>
          <h1>Good morning, Director.</h1>
          <p>Monitor audit accuracy, margin recovery, inventory variance, and AI-guided next actions.</p>
        </div>
        <button className="button secondary" type="button" onClick={() => setPage("reports")}>
          Upload report
        </button>
      </section>

      <section className="metrics-grid">
        <MetricCard title="AI Accuracy" value={qualityScore === null ? "-" : formatPercentLike(qualityScore)} icon="AI" trend={report ? "From uploaded report" : "Waiting for upload"} tone="primary" />
        <MetricCard title="Recovered Value" value={recovered === null ? "-" : formatUsd(recovered)} icon="$" trend={report ? "Estimated from report data" : "No file analyzed"} tone="success" />
        <MetricCard title="Risk Level" value={report ? riskLabel[report.risk_level] ?? report.risk_level : "-"} icon="!" trend={report ? `${highRiskCount} high-risk items` : "Waiting for upload"} tone="warning" />
        <MetricCard title="Open Issues" value={report?.total_findings ?? "-"} icon="IO" trend={report ? `${fraudCount} audit signals` : "No report loaded"} tone="danger" />
      </section>

      <section className="overview-grid">
        <MainAnalysisCard report={report} setPage={setPage} />
        <UploadDropzone {...uploadProps} />
      </section>
    </div>
  );
}

function MetricCard({ title, value, icon, trend, tone }: { title: string; value: string | number; icon: string; trend: string; tone: string }) {
  return (
    <article className={`metric-card ${tone}`}>
      <div className="metric-icon">{icon}</div>
      <span>{title}</span>
      <strong>{value}</strong>
      <small>{trend}</small>
    </article>
  );
}

function MainAnalysisCard({ report, setPage }: { report: AuditReport | null; setPage: (page: Page) => void }) {
  const findings = prioritizeFindings(report?.findings ?? []).slice(0, 3);

  return (
    <section className="panel analysis-card">
      <div className="panel-head">
        <div>
          <span className="eyebrow">Main analysis</span>
          <h2>{report ? `Analyzing: ${report.file_name}` : "Upload a report to start analysis"}</h2>
        </div>
        <span className="status-pill">{report ? "Live audit" : "No file loaded"}</span>
      </div>
      <div className="stepper">
        {["File Parsed", "Data Normalized", "Risk Mapping", "Finished"].map((step, index) => (
          <div className={report ? "step done" : "step pending"} key={step}>
            <span>{index + 1}</span>
            {step}
          </div>
        ))}
      </div>
      <div className="progress-track">
        <span style={{ width: report ? "100%" : "0%" }} />
      </div>
      <div className="panel-subhead">
        <h3>Detected Issues & Reasoning</h3>
        <button className="button ghost" type="button" onClick={() => setPage("risk")}>
          View all
        </button>
      </div>
      <div className="issue-list">
        {findings.map((issue, index) => (
          <IssueCard finding={issue} key={`${issue.code}-${index}`} />
        ))}
        {!report ? (
          <div className="empty-state">
            <strong>No analyzed document yet.</strong>
            <p>Upload XLSX, CSV, TXT, PDF, or an image. Aura AI will only show findings after reading your actual file.</p>
          </div>
        ) : null}
        {report && !findings.length ? (
          <div className="empty-state success">
            <strong>No issues found in the current audit.</strong>
            <p>Ask Aura AI a question if you want a deeper explanation of the uploaded document.</p>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function IssueCard({ finding }: { finding: Finding }) {
  return (
    <article className="issue-card">
      <div>
        <span className={`severity-badge ${finding.severity}`}>{severityLabel[finding.severity]}</span>
        <h3>{finding.title}</h3>
        <p>{finding.description}</p>
      </div>
      <button className="button secondary" type="button">
        View Details
      </button>
    </article>
  );
}

function UploadDropzone({
  file,
  setFile,
  storeId,
  setStoreId,
  periodMonth,
  setPeriodMonth,
  onSubmit,
  isLoading,
  error,
}: UploadProps) {
  return (
    <section className="panel upload-panel">
      <div className="panel-head">
        <div>
          <span className="eyebrow">Upload flow</span>
          <h2>Retail report intake</h2>
        </div>
      </div>
      <form className="form" onSubmit={onSubmit}>
        <label>
          Store ID
          <input value={storeId} onChange={(event) => setStoreId(event.target.value)} />
        </label>
        <label>
          Report month
          <input type="month" value={periodMonth} onChange={(event) => setPeriodMonth(event.target.value)} />
        </label>
        <label className={isLoading ? "file-drop loading" : "file-drop"}>
          <span className="upload-icon">UP</span>
          <strong>{file ? file.name : "Drop your retail reports here"}</strong>
          <small>Supports CSV, XLSX, PDF reports</small>
          <em>Upload File</em>
          <input type="file" accept={acceptDocuments} onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
        </label>
        {file ? (
          <div className="selected-file">
            <div>
              <strong>{file.name}</strong>
              <span>
                {formatFileSize(file.size)} / {file.type || "document"}
              </span>
            </div>
            <button className="button ghost" type="button" onClick={() => setFile(null)} disabled={isLoading}>
              Clear
            </button>
          </div>
        ) : null}
        {isLoading ? <div className="skeleton-line" /> : null}
        {error ? <p className="error">{error}</p> : null}
        <button className="button full" disabled={isLoading}>
          {isLoading ? "Analyzing report..." : "Upload and analyze"}
        </button>
      </form>
    </section>
  );
}

function ReportsPage({
  uploadProps,
  report,
  history,
  selectReport,
  documentContext,
  activeReportFile,
}: {
  uploadProps: UploadProps;
  report: AuditReport | null;
  history: AuditReport[];
  selectReport: (report: AuditReport) => void;
  documentContext: string;
  activeReportFile: File | null;
}) {
  return (
    <div className="reports-layout">
      <UploadDropzone {...uploadProps} />
      <section className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">Current report</span>
            <h2>{report?.file_name ?? "No report selected"}</h2>
          </div>
          <span className="status-pill">{report ? riskLabel[report.risk_level] ?? report.risk_level : "Waiting"}</span>
        </div>
        <p className="muted">{report?.summary ?? "Upload a report to populate audit context."}</p>
        <DocumentContextCard report={report} documentContext={documentContext} activeReportFile={activeReportFile} />
        <div className="history-list">
          {history.map((item) => (
            <button className="history-item" type="button" key={item.id} onClick={() => selectReport(item)}>
              <span>{item.file_name}</span>
              <small>
                {new Date(item.created_at).toLocaleDateString("en-US")} / {riskLabel[item.risk_level] ?? item.risk_level}
              </small>
            </button>
          ))}
          {!history.length ? <p className="muted">Report history will appear after your first audit.</p> : null}
        </div>
      </section>
    </div>
  );
}

function DocumentContextCard({
  report,
  documentContext,
  activeReportFile,
}: {
  report: AuditReport | null;
  documentContext: string;
  activeReportFile: File | null;
}) {
  let title = "No source document loaded";
  let text = "Upload a file to let Aura AI read the document before answering.";
  let tone = "idle";

  if (report && documentContext) {
    title = "Document text is ready for chat";
    text = `${documentContext.length.toLocaleString("en-US")} characters extracted from ${activeReportFile?.name ?? report.file_name}.`;
    tone = "ready";
  } else if (report && activeReportFile && shouldAttachFileToGemini(activeReportFile)) {
    title = "Document file will be sent to Gemini";
    text = `${activeReportFile.name} will be attached to chat questions so Gemini can inspect it directly.`;
    tone = "ready";
  } else if (report) {
    title = "Structured audit is available";
    text = "This report was selected from history or has no readable raw text. Chat will use summary, metrics, and findings.";
    tone = "warning";
  }

  return (
    <div className={`document-context ${tone}`}>
      <strong>{title}</strong>
      <span>{text}</span>
    </div>
  );
}

function InventoryPage({ report, totals }: { report: AuditReport | null; totals: Record<string, number> }) {
  return (
    <div className="page-stack">
      <section className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">Inventory Insights</span>
            <h2>Inventory performance snapshot</h2>
          </div>
          <span className="status-pill">{report ? `${report.total_findings} issues` : "No file loaded"}</span>
        </div>
        {report ? (
          <div className="kpi-grid">
            {mainKpiKeys.map((key) => (
              <KpiBar key={key} label={kpiLabels[key]} value={Number(totals[key] ?? 0)} max={maxKpi(totals)} />
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <strong>No inventory data yet.</strong>
            <p>Upload a spreadsheet or document. Inventory insights will be generated only from your parsed file.</p>
          </div>
        )}
      </section>
      {report ? (
        <section className="insight-grid">
          <InsightCard title="Report Totals" text="Computed from the uploaded document metrics." metric={formatMoney(Number(totals.sales ?? 0))} />
          <InsightCard title="Risk Signals" text="Prioritized from audit findings in this file." metric={`${report.total_findings} issues`} />
          <InsightCard title="Quality Score" text="Calculated from detected inconsistencies." metric={`${report.workbook_profile?.quality_score ?? Math.max(0, 100 - report.risk_score)}/100`} />
        </section>
      ) : null}
    </div>
  );
}

function RiskAuditPage({
  report,
  history,
  selectReport,
}: {
  report: AuditReport | null;
  history: AuditReport[];
  selectReport: (report: AuditReport) => void;
}) {
  const [selectedFinding, setSelectedFinding] = useState<Finding | null>(null);
  const [historySearch, setHistorySearch] = useState("");
  const [riskFilter, setRiskFilter] = useState<HistoryRiskFilter>("all");
  const visibleFindings = useMemo(() => prioritizeFindings(report?.findings ?? []).slice(0, visibleFindingsLimit), [report]);
  const ownerSummary = useMemo(() => buildOwnerSummary(report), [report]);
  const filteredHistory = useMemo(() => filterHistory(history, historySearch, riskFilter), [history, historySearch, riskFilter]);

  useEffect(() => {
    setSelectedFinding(visibleFindings[0] ?? null);
  }, [report?.id, visibleFindings]);

  return (
    <div className="page-stack">
      <section className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">Risk Audit</span>
            <h2>Detected Issues & Reasoning</h2>
          </div>
        </div>
        {report ? (
          <div className="summary-grid">
            <div className="summary-box wide">
              <strong>{report.file_name}</strong>
              <p>{report.summary}</p>
            </div>
            {ownerSummary.map((item) => (
              <div className="summary-box" key={item.title}>
                <strong>{item.title}</strong>
                <p>{item.text}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">Upload a document to see the risk audit.</p>
        )}
      </section>

      <section className="panel">
        <div className="issue-list">
          {visibleFindings.map((finding, index) => (
            <button
              className="issue-button"
              type="button"
              key={`${finding.code}-${index}`}
              onClick={() => setSelectedFinding(finding)}
            >
              <IssueCard finding={finding} />
            </button>
          ))}
          {!report?.findings.length ? <p className="muted">No audit findings yet.</p> : null}
        </div>
        {selectedFinding ? (
          <div className="finding-detail">
            <span className={`severity-badge ${selectedFinding.severity}`}>{severityLabel[selectedFinding.severity]}</span>
            <h3>{selectedFinding.title}</h3>
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
          <h2>Report history</h2>
          <span className="status-pill">
            {filteredHistory.length} of {history.length}
          </span>
        </div>
        <div className="history-filters">
          <input value={historySearch} onChange={(event) => setHistorySearch(event.target.value)} placeholder="Search by file" />
          <select value={riskFilter} onChange={(event) => setRiskFilter(event.target.value as HistoryRiskFilter)}>
            <option value="all">All risks</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>
        <div className="history-list">
          {filteredHistory.map((item) => (
            <button className="history-item" type="button" key={item.id} onClick={() => selectReport(item)}>
              <span>{item.file_name}</span>
              <small>
                {new Date(item.created_at).toLocaleDateString("en-US")} / {riskLabel[item.risk_level] ?? item.risk_level}
              </small>
            </button>
          ))}
          {history.length && !filteredHistory.length ? <p className="muted">No reports match these filters.</p> : null}
          {!history.length ? <p className="muted">History appears after your first audit.</p> : null}
        </div>
      </section>
    </div>
  );
}

function InsightsPage({ report, setPage }: { report: AuditReport | null; setPage: (page: Page) => void }) {
  const topFinding = prioritizeFindings(report?.findings ?? [])[0];
  if (!report) {
    return (
      <div className="page-stack">
        <div className="section-title">
          <span className="eyebrow">Aura AI</span>
          <h1>AI Insights Hub</h1>
        </div>
        <section className="panel">
          <div className="empty-state">
            <strong>No AI insights yet.</strong>
            <p>Upload a real report first. Aura AI will generate insights from that document instead of showing placeholder business data.</p>
            <button className="button" type="button" onClick={() => setPage("reports")}>
              Upload report
            </button>
          </div>
        </section>
      </div>
    );
  }
  return (
    <div className="page-stack">
      <div className="section-title">
        <span className="eyebrow">Aura AI</span>
        <h1>AI Insights Hub</h1>
      </div>
      <section className="insights-layout">
        <InsightCard
          large
          title={topFinding ? topFinding.title : "No critical insight detected in the current report."}
          text={topFinding ? topFinding.suggested_fix : "Aura AI did not find a high-priority issue in the parsed findings. Ask the chat for a deeper review of the uploaded document."}
          metric={`${report.total_findings} findings`}
          action="Generate Executive Summary"
          onAction={() => setPage("reports")}
        />
        <article className="optimization-card">
          <span>Optimization Potential</span>
          <strong>{formatMoney(Math.abs(Number(report.workbook_profile?.metric_totals?.profit ?? 0)) * 0.08)}</strong>
          <p>Estimated from current report profit, not a guaranteed recovery.</p>
          <button className="button full" type="button" onClick={() => setPage("risk")}>
            Create action plan
          </button>
        </article>
      </section>
      <section className="insight-grid">
        {buildReportInsightCards(report).map((item) => (
          <InsightCard title={item.title} text={item.text} metric={item.metric} key={item.title} />
        ))}
      </section>
    </div>
  );
}

function InsightCard({
  title,
  text,
  metric,
  action,
  onAction,
  large = false,
}: {
  title: string;
  text: string;
  metric: string;
  action?: string;
  onAction?: () => void;
  large?: boolean;
}) {
  return (
    <article className={large ? "insight-card large" : "insight-card"}>
      <span className="card-dot" />
      <strong>{title}</strong>
      <p>{text}</p>
      <small>{metric}</small>
      {action ? (
        <button className="button secondary" type="button" onClick={onAction}>
          {action}
        </button>
      ) : null}
    </article>
  );
}

function AnalyticsPage({ report, comparison, rows }: { report: AuditReport | null; comparison: ReportComparison | null; rows: MonthlyRow[] }) {
  const sales = Number(report?.workbook_profile?.metric_totals?.sales ?? 0);
  return (
    <div className="page-stack">
      <div className="section-title">
        <span className="eyebrow">Advanced Analytics</span>
        <h1>Advanced Analytics</h1>
      </div>
      <section className="analytics-grid">
        <AnalyticsChart rows={rows} />
        <article className="panel forecast-card">
          <span className="eyebrow">AI Key Sales Forecast</span>
          <h2>{report ? formatUsd(sales) : "-"}</h2>
          <p>
            {report
              ? "Forecast and recommendations are based on the uploaded report context. Ask Aura AI for a detailed scenario before acting."
              : "Upload at least one report to generate sales forecasts from real data."}
          </p>
          <div className="forecast-meta">
            <span>Confidence</span>
            <strong>{report ? "Report-based" : "-"}</strong>
          </div>
          {comparison ? <p className="muted">{comparison.summary}</p> : null}
        </article>
      </section>
      <StorePerformanceTable report={report} />
    </div>
  );
}

function AnalyticsChart({ rows }: { rows: MonthlyRow[] }) {
  const chartRows = rows.slice(-6);
  const maxSales = Math.max(1, ...chartRows.map((row) => Math.abs(row.sales)));

  return (
    <section className="panel analytics-chart">
      <div className="panel-head">
        <div>
          <span className="eyebrow">Growth Parity Comparison</span>
          <h2>Revenue versus risk</h2>
        </div>
      </div>
      {chartRows.length ? (
        <div className="bar-chart">
          {chartRows.map((row) => (
            <div className="chart-column" key={row.key}>
              <span className="bar sales" style={{ height: `${Math.max(12, (Math.abs(row.sales) / maxSales) * 100)}%` }} />
              <span className="bar risk" style={{ height: `${Math.max(12, row.riskScore)}%` }} />
              <small>{row.label.slice(0, 3)}</small>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty-state chart-empty">
          <strong>No analytics data yet.</strong>
          <p>Upload reports and the chart will be built from your real monthly history.</p>
        </div>
      )}
    </section>
  );
}

function StorePerformanceTable({ report }: { report: AuditReport | null }) {
  const totals = report?.workbook_profile?.metric_totals ?? {};
  const rows = report
    ? [
        [
          report.file_name,
          formatMoney(Number(totals.sales ?? 0)),
          riskLabel[report.risk_level] ?? report.risk_level,
          formatMoney(Number(totals.profit ?? 0)),
          String(report.workbook_profile?.quality_score ?? Math.max(0, 100 - report.risk_score)),
          report.total_findings ? "Review" : "Clear",
        ],
      ]
    : [];
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <span className="eyebrow">Store Performance Index</span>
          <h2>{report ? "Live store performance" : "Store Performance Index"}</h2>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Location</th>
              <th>Revenue</th>
              <th>Risk</th>
              <th>Margin</th>
              <th>AI Score</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row[0]}>
                {row.map((cell, index) => (
                  <td key={cell}>{index === 2 ? <span className={`severity-badge ${cell.toLowerCase()}`}>{cell}</span> : cell}</td>
                ))}
              </tr>
            ))}
            {!rows.length ? (
              <tr>
                <td colSpan={6}>
                  <div className="empty-state table-empty">
                    <strong>No store performance data yet.</strong>
                    <p>Upload a report to populate this table from real parsed values.</p>
                  </div>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SettingsPage({
  personalInfo,
  setPersonalInfo,
  user,
}: {
  personalInfo: string;
  setPersonalInfo: (value: string) => void;
  user: User;
}) {
  return (
    <section className="panel settings-panel">
      <div className="panel-head">
        <div>
          <span className="eyebrow">Settings</span>
          <h2>Aura AI memory</h2>
        </div>
      </div>
      <p className="muted">Signed in as {user.email}. Add context Aura AI should remember while analyzing your retail data.</p>
      <label className="memory-box">
        <span>Business context</span>
        <textarea
          value={personalInfo}
          onChange={(event) => setPersonalInfo(event.target.value)}
          placeholder="Store format, city, product categories, answer style..."
        />
      </label>
    </section>
  );
}

function AIChat({
  report,
  question,
  setQuestion,
  askGemini,
  chatAnswer,
  isChatLoading,
  aiStatus,
  messages,
  attachedPhotos,
  setAttachedPhotos,
  clearChat,
  documentContext,
  activeReportFile,
}: {
  report: AuditReport | null;
  question: string;
  setQuestion: (value: string) => void;
  askGemini: (event: { preventDefault: () => void }, mode?: "chat" | "image") => void;
  chatAnswer: ChatResponse | null;
  isChatLoading: boolean;
  aiStatus: AiStatus;
  messages: ChatMessage[];
  attachedPhotos: ChatPhoto[];
  setAttachedPhotos: (value: ChatPhoto[]) => void;
  clearChat: () => void;
  documentContext: string;
  activeReportFile: File | null;
}) {
  const [isToolsOpen, setIsToolsOpen] = useState(false);

  async function onPhotoChange(files: FileList | null) {
    if (!files?.length) return;
    const photos = await Promise.all(Array.from(files).slice(0, 3).map(fileToChatPhoto));
    setAttachedPhotos([...attachedPhotos, ...photos].slice(0, 3));
    setIsToolsOpen(false);
  }

  return (
    <aside className="ai-chat-panel">
      <div className="chat-head">
        <div>
          <span className="eyebrow">AI Assistant</span>
          <h2>Aura AI</h2>
        </div>
        <button className="icon-button" type="button" onClick={clearChat} aria-label="New chat" title="New chat">
          +
        </button>
      </div>

      <div className={`ai-status ${aiStatus.tone}`}>
        <strong>{isChatLoading ? "Aura AI is thinking" : aiStatus.label}</strong>
        <span>{report ? buildChatContextLabel(report, documentContext, activeReportFile) : aiStatus.detail}</span>
      </div>

      <div className="prompt-templates" aria-label="Quick prompts">
        {chatPromptTemplates.map((template) => (
          <button type="button" key={template} onClick={() => setQuestion(template)} disabled={isChatLoading}>
            {template}
          </button>
        ))}
      </div>

      <div className="chat-thread">
        {messages.slice(-6).map((message) => (
          <div className={message.role === "user" ? "chat-bubble user" : "chat-bubble assistant"} key={message.id}>
            <span>{message.role === "user" ? "You" : message.source === "fallback" ? "Local answer" : message.model || "Aura AI"}</span>
            <p>{message.text}</p>
            {message.photos?.length ? (
              <div className="chat-photo-grid">
                {message.photos.map((photo) => (
                  <img src={photo.url} alt={photo.name} key={photo.url} />
                ))}
              </div>
            ) : null}
            {message.imageUrl ? <img className="generated-image" src={message.imageUrl} alt="Generated AI result" /> : null}
          </div>
        ))}
        {!messages.length ? (
          <div className="chat-empty">
            <strong>Ask Aura AI about your retail data...</strong>
            <span>Use quick prompts or type a custom question.</span>
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
          placeholder="Ask Aura AI about your retail data..."
          rows={1}
        />
        <div className="composer-actions">
          <div className="composer-tools">
            <button className="icon-button" type="button" aria-label="Open tools" onClick={() => setIsToolsOpen((value) => !value)}>
              +
            </button>
            {isToolsOpen ? (
              <div className="tools-menu">
                <label className="tools-menu-item">
                  Photo
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
                  Image AI
                </button>
              </div>
            ) : null}
          </div>
          <button className="send-button" disabled={isChatLoading || !question.trim()} aria-label="Send">
            {isChatLoading ? "..." : "Send"}
          </button>
        </div>
      </form>

      {chatAnswer ? (
        <div className="chat-answer">
          <span>{chatAnswer.used_ai ? "Aura AI response" : "Fallback response"}</span>
          <p>{chatAnswer.answer}</p>
        </div>
      ) : null}
    </aside>
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
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value)} KZT`;
}

function formatUsd(value: number) {
  return `$${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0, notation: value >= 1000000 ? "compact" : "standard" }).format(value)}`;
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatPercentLike(value: number) {
  const normalized = Math.max(0, Math.min(100, value));
  return `${Number(normalized).toFixed(normalized % 1 ? 1 : 0)}%`;
}

function buildChatContextLabel(report: AuditReport, documentContext: string, activeReportFile: File | null) {
  if (documentContext) {
    return `Reading source text from ${activeReportFile?.name ?? report.file_name} plus audit findings.`;
  }
  if (activeReportFile && shouldAttachFileToGemini(activeReportFile)) {
    return `Attaching ${activeReportFile.name} to Gemini with the audit findings.`;
  }
  return "Using saved audit summary, metrics, and findings. Re-upload the file for raw document context.";
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
      title: "Today",
      text: topFinding
        ? `Start with ${topFinding.title}. ${topFinding.suggested_fix}`
        : "No critical findings detected. Continue planned sales and expense checks.",
    },
    {
      title: "Finance",
      text: `Sales ${formatMoney(sales)}, profit ${formatMoney(profit)}, expenses ${formatMoney(expense)}, returns ${formatMoney(returnValue)}.`,
    },
    {
      title: "Control",
      text: `Report quality ${quality}/100, risk ${riskLabel[report.risk_level] ?? report.risk_level}, findings ${report.total_findings}.`,
    },
  ];
}

function buildReportInsightCards(report: AuditReport) {
  const totals = report.workbook_profile?.metric_totals ?? {};
  const quality = report.workbook_profile?.quality_score ?? Math.max(0, 100 - report.risk_score);
  const highRisk = report.findings.filter((item) => ["high", "critical"].includes(item.severity)).length;
  const topFinding = prioritizeFindings(report.findings)[0];

  return [
    {
      title: "Operational Actions",
      text: topFinding ? topFinding.suggested_fix : "No urgent action was detected in the parsed findings.",
      metric: topFinding ? severityLabel[topFinding.severity] : "Clear",
    },
    {
      title: "Financial Totals",
      text: "Computed from metric columns detected in the uploaded report.",
      metric: formatMoney(Number(totals.sales ?? 0)),
    },
    {
      title: "Risk Audit",
      text: "High-priority findings found in this document.",
      metric: `${highRisk} high risk`,
    },
    {
      title: "Data Quality",
      text: "Quality score based on parsed structure and detected inconsistencies.",
      metric: `${quality}/100`,
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
      answer: "Aura AI is waiting for report context. Upload a retail file for a grounded analysis, or ask a general question and I will answer normally.",
    };
  }

  const totals = report.workbook_profile?.metric_totals ?? {};
  const topFindings = prioritizeFindings(report.findings);
  return {
    used_ai: false,
    answer: [
      `Risk: ${riskLabel[report.risk_level] ?? report.risk_level}. Findings: ${report.total_findings}.`,
      `Sales: ${formatMoney(Number(totals.sales ?? 0))}. Profit: ${formatMoney(Number(totals.profit ?? 0))}. Expenses: ${formatMoney(Number(totals.expense ?? 0))}.`,
      topFindings[0] ? `Start with ${topFindings[0].title}. ${topFindings[0].suggested_fix}` : "No severe findings detected.",
      `Question: ${question}`,
    ].join(" "),
  };
}

function buildGeneralGeminiPrompt(
  report: AuditReport | null,
  question: string,
  personalInfo = "",
  messages: ChatMessage[] = [],
  documentContext = "",
) {
  const memory = personalInfo.trim() ? `User memory:\n${personalInfo.trim()}` : "";
  const recentMessages = messages.slice(-8).map((item) => `${item.role === "user" ? "User" : "Aura AI"}: ${item.text}`).join("\n");
  const history = recentMessages ? `Recent conversation:\n${recentMessages}` : "";

  if (!report) {
    return [
      memory,
      history,
      `User question: ${question}`,
      "Answer any question the user asks. If it is about retail, analytics, files, documents, business, or the current app, be practical and specific. If the question is general or unrelated, answer normally.",
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
    `User question: ${question}`,
    "Answer any user question. Use the uploaded document/report context when it is relevant. If the answer needs facts from the file, rely on the context below and say clearly when something is not present.",
    JSON.stringify(reportContext, null, 2),
    documentContext
      ? `Extracted source document content / spreadsheet preview:\n${documentContext}`
      : "No raw source document text is available. Use the structured audit context if the question is about the uploaded report.",
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
    reader.onerror = () => reject(new Error("Could not read photo"));
    reader.readAsDataURL(file);
  });
}

function shouldAttachFileToGemini(file: File) {
  const name = file.name.toLowerCase();
  if (/\.(xlsx|xls|xlsm|xlsb|csv|tsv|ods)$/.test(name)) return false;
  return file.type.startsWith("image/") || file.type === "application/pdf" || /\.(pdf|png|jpg|jpeg|webp)$/i.test(name);
}

function fileToAiPart(file: File): Promise<{ mimeType: string; data: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result ?? "");
      resolve({
        mimeType: file.type || guessFileMimeType(file.name),
        data: value.includes(",") ? value.split(",")[1] : value,
      });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function guessFileMimeType(name: string) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
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
        label: new Date(`${key}-01T00:00:00`).toLocaleDateString("en-US", { month: "short", year: "numeric" }),
        sales: Number(totals.sales ?? 0),
        profit: Number(totals.profit ?? 0),
        expense: Number(totals.expense ?? 0),
        riskScore: item.risk_score,
      };
    });
}

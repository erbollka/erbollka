import { FormEvent, useEffect, useMemo, useState } from "react";
import { AuditReport } from "../lib/api";
import {
  FashionMessage,
  WeeklyKpi,
  buildFashionPrompt,
  buildFashionSystemPrompt,
  fallbackFashionAnswer,
  fashionPromptIdeas,
  formatCompactMoney,
} from "../lib/fashionAssistant";

type FashionAssistantProps = {
  report: AuditReport | null;
};

const defaultKpis: WeeklyKpi[] = [
  { label: "Выручка", current: 4850000, target: 5600000, unit: " ₸" },
  { label: "Средний чек", current: 6200, target: 7000, unit: " ₸" },
  { label: "Конверсия", current: 18, target: 24, unit: "%" },
  { label: "Допродажи", current: 31, target: 42, unit: "%" },
];

export function FashionAssistant({ report }: FashionAssistantProps) {
  const totals = report?.workbook_profile?.metric_totals ?? {};
  const [kpis, setKpis] = useState<WeeklyKpi[]>(() => {
    const sales = Number(totals.sales ?? 0);
    return sales > 0 ? [{ ...defaultKpis[0], current: sales, target: Math.round(sales * 1.12) }, ...defaultKpis.slice(1)] : defaultKpis;
  });
  const [question, setQuestion] = useState(fashionPromptIdeas[0]);
  const [messages, setMessages] = useState<FashionMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      text: "Я помогу команде fashion retail обсуждать KPI, продажи, витрину, скидки, ассортимент и идеи на неделю.",
    },
  ]);
  const [isThinking, setIsThinking] = useState(false);

  const context = useMemo(
    () => ({
      sales: Number(totals.sales ?? defaultKpis[0].current),
      profit: Number(totals.profit ?? 690000),
      discount: Number(totals.discount ?? 265000),
      returns: Number(totals.return ?? 180000),
      riskLevel: report?.risk_level ?? "demo",
      summary: report?.summary ?? "Демо-контекст fashion магазина без загруженного Excel.",
      qualityScore: report?.workbook_profile?.quality_score,
      recommendations: report?.recommendations ?? [],
      sheetNames: report?.workbook_profile?.sheets?.map((sheet) => sheet.name) ?? [],
      findings:
        report?.findings.slice(0, 8).map((item) => ({
          code: item.code,
          severity: item.severity,
          title: item.title,
          description: item.description,
          suggestedFix: item.suggested_fix,
          sheetName: item.sheet_name,
          cell: item.cell,
        })) ?? [],
    }),
    [report, totals],
  );

  useEffect(() => {
    const sales = Number(totals.sales ?? 0);
    if (sales <= 0) return;
    setKpis((items) =>
      items.map((item, index) =>
        index === 0 ? { ...item, current: sales, target: Math.max(item.target, Math.round(sales * 1.12)) } : item,
      ),
    );
  }, [totals.sales]);

  function updateTarget(index: number, target: number) {
    setKpis((items) => items.map((item, itemIndex) => (itemIndex === index ? { ...item, target } : item)));
  }

  async function askAssistant(event?: FormEvent<HTMLFormElement>, prompt = question) {
    event?.preventDefault();
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt || isThinking) return;

    const userMessage: FashionMessage = { id: crypto.randomUUID(), role: "user", text: cleanPrompt };
    const assistantMessageId = crypto.randomUUID();
    const localAnswer = fallbackFashionAnswer(cleanPrompt, context, kpis);
    setMessages((items) => [...items, userMessage, { id: assistantMessageId, role: "assistant", text: localAnswer }]);
    setQuestion(cleanPrompt);
    setIsThinking(true);

    try {
      const { supabase } = await import("../lib/supabase");
      const { data, error } = await withTimeout(
        supabase.functions.invoke("ai", {
          body: {
            system: buildFashionSystemPrompt(),
            prompt: buildFashionPrompt(cleanPrompt, context, kpis),
          },
        }),
        8000,
      );

      if (!error && typeof data?.text === "string" && data.text.trim()) {
        setMessages((items) =>
          items.map((item) => (item.id === assistantMessageId ? { ...item, text: data.text.trim() } : item)),
        );
      }
    } catch {
      // The local answer is already shown. Remote AI is optional.
    } finally {
      setIsThinking(false);
    }
  }

  return (
    <section className="panel fashion-assistant">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Fashion retail AI</p>
          <h2>Личный AI-ассистент команды</h2>
        </div>
        <span className="demo-badge">KPI + идеи</span>
      </div>

      <div className="assistant-grid">
        <div className="assistant-column">
          <div className="assistant-summary">
            <strong>Контекст недели</strong>
            <span>Выручка: {formatCompactMoney(context.sales)} ₸</span>
            <span>Прибыль: {formatCompactMoney(context.profit)} ₸</span>
            <span>Скидки: {formatCompactMoney(context.discount)} ₸</span>
            <span>Возвраты: {formatCompactMoney(context.returns)} ₸</span>
          </div>

          <div className="weekly-kpis">
            {kpis.map((item, index) => (
              <KpiTarget key={item.label} item={item} onChange={(target) => updateTarget(index, target)} />
            ))}
          </div>
        </div>

        <div className="assistant-chat">
          <div className="prompt-row">
            {fashionPromptIdeas.map((item) => (
              <button key={item} type="button" className="prompt-chip" onClick={() => askAssistant(undefined, item)}>
                {item}
              </button>
            ))}
          </div>

          <div className="assistant-messages">
            {messages.map((message) => (
              <div key={message.id} className={`assistant-message ${message.role}`}>
                {message.text.split("\n").map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>
            ))}
            {isThinking ? <div className="assistant-message assistant">Думаю над ответом для команды...</div> : null}
          </div>

          <form className="chat-form" onSubmit={askAssistant}>
            <input value={question} onChange={(event) => setQuestion(event.target.value)} />
            <button className="button compact" disabled={isThinking}>
              {isThinking ? "Думаю..." : "Спросить"}
            </button>
          </form>
        </div>
      </div>
    </section>
  );
}

function KpiTarget({ item, onChange }: { item: WeeklyKpi; onChange: (target: number) => void }) {
  const progress = item.target > 0 ? Math.min(100, Math.round((item.current / item.target) * 100)) : 0;

  return (
    <div className="kpi-target">
      <div>
        <strong>{item.label}</strong>
        <span>
          {formatKpi(item.current, item.unit)} / {formatKpi(item.target, item.unit)}
        </span>
      </div>
      <div className="bar-track">
        <div className="bar-fill" style={{ width: `${Math.max(4, progress)}%` }} />
      </div>
      <label>
        Цель на неделю
        <input
          type="number"
          min="0"
          value={item.target}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      </label>
    </div>
  );
}

function formatKpi(value: number, unit: string) {
  if (unit.includes("₸")) {
    return `${formatCompactMoney(value)} ₸`;
  }
  return `${value}${unit}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      window.setTimeout(() => reject(new Error("AI request timed out")), timeoutMs);
    }),
  ]);
}

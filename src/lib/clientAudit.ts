import * as XLSX from "xlsx";
import type { AuditReport, Finding, Severity, WorkbookProfile } from "./api";

const metricPatterns: Record<string, string[]> = {
  sales: ["sale", "revenue", "выруч", "продаж"],
  profit: ["profit", "приб", "марж"],
  salary: ["salary", "зарп", "оклад"],
  bonus: ["bonus", "прем"],
  expense: ["expense", "расход", "затрат"],
  discount: ["discount", "скид"],
  return: ["return", "refund", "возврат"],
};

const requiredPatterns = ["date", "дата", "employee", "сотруд", "sales", "продаж", "total", "итого"];
const negativeForbiddenPatterns = ["sale", "продаж", "salary", "зарп", "bonus", "прем", "expense", "расход"];
const totalPatterns = ["total", "итого", "сумма", "всего"];

export async function analyzeExcelInBrowser(file: File): Promise<AuditReport> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array", cellFormula: true, cellDates: true });
  const findings: Finding[] = [];
  const profile = buildWorkbookProfile(workbook);

  workbook.SheetNames.forEach((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: true });
    findings.push(...findBlankRequiredCells(sheetName, rows));
    findings.push(...findDuplicateRows(sheetName, rows));
    findings.push(...findNegativeValues(sheetName, rows));
    findings.push(...findTotalMismatches(sheetName, rows));
  });

  const riskScore = scoreRisk(findings);
  const qualityScore = Math.max(0, 100 - riskScore);
  profile.quality_score = qualityScore;

  return {
    id: `local-${crypto.randomUUID()}`,
    file_name: file.name,
    status: "completed-local",
    risk_score: riskScore,
    risk_level: riskLevel(riskScore),
    total_findings: findings.length,
    summary: buildSummary(findings, riskScore, qualityScore),
    recommendations: buildRecommendations(findings),
    workbook_profile: profile,
    findings,
    created_at: new Date().toISOString(),
  };
}

export async function analyzeDocumentInBrowser(file: File): Promise<AuditReport> {
  if (isSpreadsheet(file)) {
    return analyzeExcelInBrowser(file);
  }

  const text = await tryReadText(file);
  if (text.trim()) {
    return buildTextDocumentReport(file, text);
  }

  const geminiText = await tryAnalyzeWithGemini(file);
  if (geminiText) {
    return buildGeminiDocumentReport(file, geminiText);
  }

  return buildUnsupportedDocumentReport(file);
}

export async function extractDocumentContext(file: File): Promise<string> {
  if (isSpreadsheet(file)) {
    return extractSpreadsheetContext(file);
  }

  const text = await tryReadText(file);
  if (text.trim()) {
    return trimDocumentContext(text);
  }

  return "";
}

async function extractSpreadsheetContext(file: File) {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array", cellFormula: true, cellDates: true });
  const parts: string[] = [];

  workbook.SheetNames.slice(0, 8).forEach((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "", raw: false }).slice(0, 80);
    const table = rows
      .map((row) =>
        row
          .slice(0, 18)
          .map((value) => String(value ?? "").replace(/\s+/g, " ").trim())
          .join("\t"),
      )
      .filter((line) => line.trim())
      .join("\n");
    if (table) {
      parts.push(`Sheet: ${sheetName}\n${table}`);
    }
  });

  return trimDocumentContext(parts.join("\n\n"));
}

function trimDocumentContext(text: string) {
  return text.replace(/\0/g, "").replace(/[ \t]+\n/g, "\n").trim().slice(0, 60000);
}

function buildWorkbookProfile(workbook: XLSX.WorkBook): WorkbookProfile {
  const totals: Record<string, number> = Object.fromEntries(Object.keys(metricPatterns).map((key) => [key, 0]));
  const sheets = workbook.SheetNames.map((sheetName) => {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], {
      header: 1,
      defval: null,
      raw: true,
    });
    const headers = detectHeaders(rows);
    const sheetTotals: Record<string, number> = Object.fromEntries(Object.keys(metricPatterns).map((key) => [key, 0]));

    Object.entries(headers.headers).forEach(([columnIndexText, header]) => {
      const columnIndex = Number(columnIndexText);
      const normalized = String(header).toLowerCase();
      const metric = Object.entries(metricPatterns).find(([, patterns]) =>
        patterns.some((pattern) => normalized.includes(pattern)),
      )?.[0];
      if (!metric) return;

      rows.slice(headers.rowIndex + 1).forEach((row) => {
        const value = toNumber(row[columnIndex]);
        if (value !== null) sheetTotals[metric] += value;
      });
    });

    Object.entries(sheetTotals).forEach(([key, value]) => {
      totals[key] += value;
      sheetTotals[key] = round(value);
    });

    return {
      name: sheetName,
      rows_sampled: rows.length,
      columns_sampled: rows.reduce((max, row) => Math.max(max, row.length), 0),
      non_empty_cells_sampled: rows.flat().filter((value) => value !== null && value !== "").length,
      numeric_columns_sampled: countNumericColumns(rows),
      metric_totals: sheetTotals,
    };
  });

  return {
    sheet_count: sheets.length,
    sheets,
    metric_totals: Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, round(value)])),
  };
}

function findBlankRequiredCells(sheetName: string, rows: unknown[][]): Finding[] {
  const findings: Finding[] = [];
  const { rowIndex, headers } = detectHeaders(rows);

  Object.entries(headers).forEach(([columnIndexText, header]) => {
    const columnIndex = Number(columnIndexText);
    const normalized = String(header).toLowerCase();
    if (!requiredPatterns.some((pattern) => normalized.includes(pattern))) return;

    rows.slice(rowIndex + 1, rowIndex + 501).forEach((row, index) => {
      if (findings.length >= 30) return;
      const value = row[columnIndex];
      if (value === null || value === "") {
        const excelRow = rowIndex + index + 2;
        findings.push({
          code: "REQUIRED_CELL_EMPTY",
          severity: "medium",
          sheet_name: sheetName,
          cell: `${columnLetter(columnIndex)}${excelRow}`,
          row_number: excelRow,
          column_name: String(header),
          title: "Пустая обязательная ячейка",
          description: `В колонке "${header}" пустая ячейка в строке ${excelRow}.`,
          suggested_fix: "Заполните значение или удалите строку, если она не относится к отчету.",
          evidence: {},
        });
      }
    });
  });

  return findings;
}

function findDuplicateRows(sheetName: string, rows: unknown[][]): Finding[] {
  const seen = new Map<string, number>();
  const findings: Finding[] = [];

  rows.forEach((row, index) => {
    if (index === 0 || findings.length >= 20 || row.every((value) => value === null || value === "")) return;
    const key = JSON.stringify(row.map((value) => String(value ?? "").trim()));
    const firstRow = seen.get(key);
    if (firstRow) {
      findings.push({
        code: "DUPLICATE_ROW",
        severity: "low",
        sheet_name: sheetName,
        cell: null,
        row_number: index + 1,
        column_name: null,
        title: "Дубликат строки",
        description: `Строка ${index + 1} совпадает со строкой ${firstRow}.`,
        suggested_fix: "Проверьте, не была ли операция случайно скопирована дважды.",
        evidence: { first_row: firstRow },
      });
    } else {
      seen.set(key, index + 1);
    }
  });

  return findings;
}

function findNegativeValues(sheetName: string, rows: unknown[][]): Finding[] {
  const findings: Finding[] = [];
  const { rowIndex, headers } = detectHeaders(rows);

  Object.entries(headers).forEach(([columnIndexText, header]) => {
    const columnIndex = Number(columnIndexText);
    const normalized = String(header).toLowerCase();
    if (!negativeForbiddenPatterns.some((pattern) => normalized.includes(pattern))) return;

    rows.slice(rowIndex + 1, rowIndex + 1001).forEach((row, index) => {
      const value = toNumber(row[columnIndex]);
      if (value !== null && value < 0) {
        const excelRow = rowIndex + index + 2;
        findings.push({
          code: "NEGATIVE_VALUE",
          severity: "high",
          sheet_name: sheetName,
          cell: `${columnLetter(columnIndex)}${excelRow}`,
          row_number: excelRow,
          column_name: String(header),
          title: "Отрицательное значение",
          description: `В колонке "${header}" найдено отрицательное значение ${value}.`,
          suggested_fix: "Проверьте знак числа и корректность возвратов или сторно.",
          evidence: { value },
        });
      }
    });
  });

  return findings.slice(0, 40);
}

function findTotalMismatches(sheetName: string, rows: unknown[][]): Finding[] {
  const findings: Finding[] = [];

  rows.forEach((row, rowIndex) => {
    const rowText = row.map((value) => String(value ?? "").toLowerCase()).join(" ");
    if (!totalPatterns.some((pattern) => rowText.includes(pattern))) return;

    row.forEach((value, columnIndex) => {
      const expected = toNumber(value);
      if (expected === null) return;
      const valuesAbove = rows
        .slice(Math.max(0, rowIndex - 40), rowIndex)
        .map((aboveRow) => toNumber(aboveRow[columnIndex]))
        .filter((item): item is number => item !== null);
      if (valuesAbove.length < 2) return;

      const calculated = round(valuesAbove.reduce((sum, item) => sum + item, 0));
      if (Math.abs(calculated - expected) > Math.max(1, Math.abs(expected) * 0.01)) {
        findings.push({
          code: "TOTAL_MISMATCH",
          severity: "critical",
          sheet_name: sheetName,
          cell: `${columnLetter(columnIndex)}${rowIndex + 1}`,
          row_number: rowIndex + 1,
          column_name: null,
          title: "Итог не сходится",
          description: `Итог ${expected} не совпадает с суммой строк выше ${calculated}.`,
          suggested_fix: "Проверьте диапазон формулы и строки, которые входят в итог.",
          evidence: { expected, calculated, difference: round(expected - calculated) },
        });
      }
    });
  });

  return findings.slice(0, 30);
}

function detectHeaders(rows: unknown[][]) {
  let bestRowIndex = 0;
  let bestScore = -1;
  rows.slice(0, 12).forEach((row, index) => {
    const score = row.filter((value) => typeof value === "string" && value.trim().length > 1).length;
    if (score > bestScore) {
      bestRowIndex = index;
      bestScore = score;
    }
  });

  const headers: Record<number, string> = {};
  rows[bestRowIndex]?.forEach((value, index) => {
    if (value !== null && value !== "") headers[index] = String(value);
  });
  return { rowIndex: bestRowIndex, headers };
}

function countNumericColumns(rows: unknown[][]) {
  const maxColumns = rows.reduce((max, row) => Math.max(max, row.length), 0);
  let count = 0;
  for (let columnIndex = 0; columnIndex < maxColumns; columnIndex += 1) {
    const numericValues = rows.map((row) => toNumber(row[columnIndex])).filter((value) => value !== null);
    if (numericValues.length >= 2) count += 1;
  }
  return count;
}

function scoreRisk(findings: Finding[]) {
  const weights: Record<Severity, number> = { info: 1, low: 3, medium: 8, high: 18, critical: 30 };
  return Math.min(100, findings.reduce((score, finding) => score + weights[finding.severity], 0));
}

function riskLevel(score: number) {
  if (score >= 75) return "critical";
  if (score >= 45) return "high";
  if (score >= 20) return "medium";
  return "low";
}

function buildSummary(findings: Finding[], riskScore: number, qualityScore: number) {
  if (!findings.length) {
    return `Локальный аудит завершен. Критичных ошибок не найдено. Оценка качества отчета: ${qualityScore}/100.`;
  }
  const critical = findings.filter((item) => item.severity === "critical").length;
  const high = findings.filter((item) => item.severity === "high").length;
  return `Локальный аудит завершен без backend. Найдено ${findings.length} замечаний. Критичных: ${critical}, высокого риска: ${high}. Риск: ${riskLevel(riskScore)}. Оценка качества: ${qualityScore}/100.`;
}

function buildRecommendations(findings: Finding[]) {
  const codes = new Set(findings.map((item) => item.code));
  const recommendations: string[] = [];
  if (codes.has("TOTAL_MISMATCH")) recommendations.push("Сначала проверьте итоговые строки и диапазоны формул.");
  if (codes.has("NEGATIVE_VALUE")) recommendations.push("Сверьте отрицательные значения с возвратами, сторно и первичными документами.");
  if (codes.has("REQUIRED_CELL_EMPTY")) recommendations.push("Заполните обязательные поля, чтобы отчет можно было сверить без ручных уточнений.");
  if (codes.has("DUPLICATE_ROW")) recommendations.push("Удалите случайные дубли строк перед закрытием периода.");
  return recommendations.length ? recommendations : ["Сохраните результат проверки и загрузите отчет повторно после изменений."];
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s/g, "").replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function columnLetter(index: number) {
  let dividend = index + 1;
  let column = "";
  while (dividend > 0) {
    const modulo = (dividend - 1) % 26;
    column = String.fromCharCode(65 + modulo) + column;
    dividend = Math.floor((dividend - modulo) / 26);
  }
  return column;
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

function isSpreadsheet(file: File) {
  const name = file.name.toLowerCase();
  return /\.(xlsx|xls|xlsm|xlsb|csv|tsv|ods)$/.test(name);
}

async function tryReadText(file: File) {
  const name = file.name.toLowerCase();
  const readable = /\.(txt|csv|tsv|json|xml|html|htm|md|log)$/.test(name) || file.type.startsWith("text/");
  if (!readable) return "";
  try {
    return await file.text();
  } catch {
    return "";
  }
}

async function tryAnalyzeWithGemini(file: File) {
  try {
    const { supabase } = await import("./supabase");
    const data = await fileToBase64(file);
    const { data: result, error } = await supabase.functions.invoke("ai", {
      body: {
        system:
          "Ты AI-аудитор документов для fashion retail. Прочитай документ, выдели KPI, риски, ошибки, возвраты, скидки, расходы и дай развернутый, но компактный русский отчет до 6 пунктов. Не выдумывай числа.",
        prompt:
          "Распознай загруженный документ. Верни: 1) что это за документ, 2) ключевые KPI и суммы, 3) риски/ошибки, 4) что проверить владельцу магазина.",
        files: [{ mimeType: file.type || guessMimeType(file.name), data }],
      },
    });
    if (!error && typeof result?.text === "string") return result.text.trim();
  } catch {
    return "";
  }
  return "";
}

function buildTextDocumentReport(file: File, text: string): AuditReport {
  const rows = text.split(/\r?\n/).filter((line) => line.trim()).length;
  const numbers = [...text.matchAll(/-?\d+(?:[\s.,]\d+)*/g)].slice(0, 40).map((item) => toNumber(item[0]) ?? 0);
  const total = round(numbers.reduce((sum, value) => sum + value, 0));
  const findings: Finding[] = [];

  if (text.length < 80) {
    findings.push(documentFinding("DOCUMENT_TOO_SHORT", "low", "Документ слишком короткий", "В файле мало текста для надежного анализа.", "Проверьте, что загружен полный документ."));
  }
  if (/скидк|discount/i.test(text)) {
    findings.push(documentFinding("DISCOUNT_MENTIONED", "medium", "Есть скидки", "Документ содержит упоминания скидок.", "Сверьте основания скидок с акциями и разрешениями."));
  }
  if (/возврат|refund|return/i.test(text)) {
    findings.push(documentFinding("RETURN_MENTIONED", "medium", "Есть возвраты", "Документ содержит возвраты или refund.", "Проверьте даты, чеки и причины возвратов."));
  }
  if (/расход|expense|затрат/i.test(text)) {
    findings.push(documentFinding("EXPENSE_MENTIONED", "medium", "Есть расходы", "Документ содержит расходы.", "Сравните расходы с бюджетом месяца."));
  }

  const riskScore = scoreRisk(findings);
  return {
    id: `local-${crypto.randomUUID()}`,
    file_name: file.name,
    status: "completed-local",
    risk_score: riskScore,
    risk_level: riskLevel(riskScore),
    total_findings: findings.length,
    summary: `Документ распознан как текстовый файл. Найдено строк: ${rows}, числовых значений: ${numbers.length}. Первичная сумма найденных чисел: ${total}.`,
    recommendations: buildRecommendations(findings),
    workbook_profile: {
      quality_score: Math.max(0, 100 - riskScore),
      sheet_count: 1,
      metric_totals: { sales: 0, profit: 0, salary: 0, bonus: 0, expense: 0, discount: 0, return: 0 },
      sheets: [
        {
          name: "Текст документа",
          rows_sampled: rows,
          columns_sampled: 1,
          non_empty_cells_sampled: rows,
          numeric_columns_sampled: numbers.length ? 1 : 0,
          metric_totals: {},
        },
      ],
    },
    findings,
    created_at: new Date().toISOString(),
  };
}

function buildGeminiDocumentReport(file: File, text: string): AuditReport {
  const findings = [documentFinding("GEMINI_DOCUMENT_ANALYSIS", "info", "Gemini распознал документ", text, "Используйте вывод Gemini как основу и сверяйте важные суммы с первичным документом.")];
  return {
    id: `local-${crypto.randomUUID()}`,
    file_name: file.name,
    status: "completed-gemini",
    risk_score: 12,
    risk_level: "low",
    total_findings: findings.length,
    summary: text,
    recommendations: ["Проверьте ключевые суммы, даты, скидки, возвраты и расходы по первичному документу.", "Задайте вопрос в Gemini-чате по этому документу."],
    workbook_profile: {
      quality_score: 88,
      sheet_count: 1,
      metric_totals: { sales: 0, profit: 0, salary: 0, bonus: 0, expense: 0, discount: 0, return: 0 },
      sheets: [{ name: "Gemini OCR", rows_sampled: 1, columns_sampled: 1, non_empty_cells_sampled: 1, numeric_columns_sampled: 0, metric_totals: {} }],
    },
    findings,
    created_at: new Date().toISOString(),
  };
}

function buildUnsupportedDocumentReport(file: File): AuditReport {
  const finding = documentFinding(
    "DOCUMENT_RECOGNITION_PENDING",
    "medium",
    "Файл принят, но текст не извлечен",
    `Тип ${file.type || "не указан"}, размер ${Math.round(file.size / 1024)} КБ. Для глубокого распознавания нужен доступный Gemini Edge Function.`,
    "Проверьте секрет GEMINI_API_KEY/GEMINI_MODEL и повторите загрузку или конвертируйте документ в PDF, CSV, XLSX или TXT.",
  );
  return {
    id: `local-${crypto.randomUUID()}`,
    file_name: file.name,
    status: "metadata-only",
    risk_score: 20,
    risk_level: "medium",
    total_findings: 1,
    summary: "Файл загружен и сохранен в интерфейсе, но содержимое не удалось распознать локально.",
    recommendations: [finding.suggested_fix],
    workbook_profile: {
      quality_score: 80,
      sheet_count: 1,
      metric_totals: { sales: 0, profit: 0, salary: 0, bonus: 0, expense: 0, discount: 0, return: 0 },
      sheets: [{ name: "Метаданные", rows_sampled: 1, columns_sampled: 1, non_empty_cells_sampled: 1, numeric_columns_sampled: 0, metric_totals: {} }],
    },
    findings: [finding],
    created_at: new Date().toISOString(),
  };
}

function documentFinding(code: string, severity: Severity, title: string, description: string, suggestedFix: string): Finding {
  return {
    code,
    severity,
    sheet_name: "Документ",
    cell: null,
    row_number: null,
    column_name: null,
    title,
    description,
    suggested_fix: suggestedFix,
    evidence: {},
  };
}

function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function guessMimeType(name: string) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".txt") || lower.endsWith(".csv")) return "text/plain";
  return "application/octet-stream";
}

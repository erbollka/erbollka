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

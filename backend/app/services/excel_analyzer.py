import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path
from statistics import median, pstdev
from typing import Any

import numpy as np
import openpyxl
import pandas as pd
from openpyxl.utils import get_column_letter


TOTAL_PATTERNS = ("total", "итого", "сумма", "всего")
NEGATIVE_FORBIDDEN_PATTERNS = ("sale", "продаж", "salary", "зарп", "bonus", "прем", "остат", "expense", "расход")
REQUIRED_PATTERNS = ("date", "дата", "employee", "сотруд", "sales", "продаж", "salary", "зарп", "total", "итого")


@dataclass
class Finding:
    code: str
    severity: str
    sheet_name: str
    title: str
    description: str
    suggested_fix: str
    cell: str | None = None
    row_number: int | None = None
    column_name: str | None = None
    evidence: dict[str, Any] = field(default_factory=dict)
    confidence: float = 0.85


@dataclass
class WorkbookAudit:
    file_sha256: str
    workbook_profile: dict[str, Any]
    findings: list[Finding]
    risk_score: int
    risk_level: str
    summary: str
    recommendations: list[str]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def analyze_workbook(path: Path) -> WorkbookAudit:
    findings: list[Finding] = []
    workbook_profile = _profile_workbook(path)
    workbook_formula = openpyxl.load_workbook(path, data_only=False, read_only=False)
    workbook_values = openpyxl.load_workbook(path, data_only=True, read_only=False)

    for sheet_name in workbook_formula.sheetnames:
        ws_formula = workbook_formula[sheet_name]
        ws_values = workbook_values[sheet_name]
        findings.extend(_find_formula_issues(sheet_name, ws_formula, ws_values))
        findings.extend(_find_required_blanks(sheet_name, ws_values))
        findings.extend(_find_duplicate_rows(path, sheet_name))
        findings.extend(_find_negative_values(sheet_name, ws_values))
        findings.extend(_find_outliers(path, sheet_name))
        findings.extend(_find_total_mismatches(sheet_name, ws_values))

    risk_score = _risk_score(findings)
    risk_level = _risk_level(risk_score)
    return WorkbookAudit(
        file_sha256=sha256_file(path),
        workbook_profile=workbook_profile,
        findings=findings,
        risk_score=risk_score,
        risk_level=risk_level,
        summary=_summary(findings, risk_level),
        recommendations=_recommendations(findings),
    )


def _profile_workbook(path: Path) -> dict[str, Any]:
    excel = pd.ExcelFile(path)
    sheets = []
    for sheet_name in excel.sheet_names:
        frame = excel.parse(sheet_name=sheet_name, header=None, nrows=80)
        numeric_frame = frame.select_dtypes(include=[np.number])
        sheets.append(
            {
                "name": sheet_name,
                "rows_sampled": int(frame.shape[0]),
                "columns_sampled": int(frame.shape[1]),
                "non_empty_cells_sampled": int(frame.notna().sum().sum()),
                "numeric_columns_sampled": int(numeric_frame.shape[1]),
            }
        )
    return {"sheet_count": len(sheets), "sheets": sheets}


def _find_formula_issues(sheet_name: str, ws_formula: Any, ws_values: Any) -> list[Finding]:
    findings: list[Finding] = []
    for row in ws_formula.iter_rows():
        for cell in row:
            if not isinstance(cell.value, str) or not cell.value.startswith("="):
                continue
            cached = ws_values[cell.coordinate].value
            formula = cell.value.upper()
            if cached is None:
                findings.append(
                    Finding(
                        code="FORMULA_NO_CACHED_VALUE",
                        severity="medium",
                        sheet_name=sheet_name,
                        cell=cell.coordinate,
                        title="Формула без сохраненного результата",
                        description=f"В ячейке {cell.coordinate} есть формула, но в файле нет сохраненного вычисленного значения.",
                        suggested_fix="Откройте файл в Excel, пересчитайте книгу и сохраните ее перед повторной загрузкой.",
                        evidence={"formula": cell.value},
                    )
                )
            if "SUM(" in formula and _has_suspicious_sum_range(cell.value):
                findings.append(
                    Finding(
                        code="FORMULA_SUSPICIOUS_SUM_RANGE",
                        severity="high",
                        sheet_name=sheet_name,
                        cell=cell.coordinate,
                        title="Подозрительный диапазон суммы",
                        description=f"Формула в {cell.coordinate} может суммировать неполный или слишком широкий диапазон.",
                        suggested_fix="Проверьте, что в SUM попали все строки месяца и не попали итоговые строки.",
                        evidence={"formula": cell.value},
                    )
                )
    return findings[:80]


def _has_suspicious_sum_range(formula: str) -> bool:
    ranges = re.findall(r"([A-Z]+)(\d+):([A-Z]+)(\d+)", formula.upper())
    for start_col, start_row, end_col, end_row in ranges:
        if start_col != end_col:
            return True
        if int(end_row) - int(start_row) > 400:
            return True
    return False


def _find_required_blanks(sheet_name: str, ws_values: Any) -> list[Finding]:
    findings: list[Finding] = []
    header_row, headers = _detect_headers(ws_values)
    for column_index, header in headers.items():
        normalized = str(header).lower()
        if not any(pattern in normalized for pattern in REQUIRED_PATTERNS):
            continue
        for row_index in range(header_row + 1, min(ws_values.max_row, 500) + 1):
            value = ws_values.cell(row=row_index, column=column_index).value
            if value in (None, ""):
                findings.append(
                    Finding(
                        code="REQUIRED_CELL_EMPTY",
                        severity="medium",
                        sheet_name=sheet_name,
                        cell=f"{get_column_letter(column_index)}{row_index}",
                        row_number=row_index,
                        column_name=str(header),
                        title="Пустая обязательная ячейка",
                        description=f"В колонке «{header}» пустая ячейка в строке {row_index}.",
                        suggested_fix="Заполните значение или удалите строку, если она не относится к отчету.",
                    )
                )
                if len(findings) >= 30:
                    return findings
    return findings


def _detect_headers(ws_values: Any) -> tuple[int, dict[int, str]]:
    best_row = 1
    best_score = -1
    for row_index in range(1, min(ws_values.max_row, 12) + 1):
        values = [ws_values.cell(row=row_index, column=col).value for col in range(1, ws_values.max_column + 1)]
        score = sum(1 for value in values if isinstance(value, str) and len(value.strip()) > 1)
        if score > best_score:
            best_row = row_index
            best_score = score
    headers: dict[int, str] = {}
    for col in range(1, ws_values.max_column + 1):
        value = ws_values.cell(row=best_row, column=col).value
        if value not in (None, ""):
            headers[col] = str(value)
    return best_row, headers


def _find_duplicate_rows(path: Path, sheet_name: str) -> list[Finding]:
    frame = pd.read_excel(path, sheet_name=sheet_name, dtype=str).dropna(how="all")
    if frame.empty:
        return []
    duplicated = frame.duplicated(keep=False)
    findings: list[Finding] = []
    for index in frame[duplicated].index[:20]:
        findings.append(
            Finding(
                code="DUPLICATE_ROW",
                severity="low",
                sheet_name=sheet_name,
                row_number=int(index) + 2,
                title="Дубликат строки",
                description=f"Строка {int(index) + 2} полностью совпадает с другой строкой на листе.",
                suggested_fix="Проверьте, не была ли строка случайно скопирована дважды.",
            )
        )
    return findings


def _find_negative_values(sheet_name: str, ws_values: Any) -> list[Finding]:
    findings: list[Finding] = []
    _, headers = _detect_headers(ws_values)
    for column_index, header in headers.items():
        normalized = str(header).lower()
        if not any(pattern in normalized for pattern in NEGATIVE_FORBIDDEN_PATTERNS):
            continue
        for row_index in range(2, min(ws_values.max_row, 1000) + 1):
            value = ws_values.cell(row=row_index, column=column_index).value
            if isinstance(value, (int, float)) and value < 0:
                findings.append(
                    Finding(
                        code="NEGATIVE_VALUE",
                        severity="high",
                        sheet_name=sheet_name,
                        cell=f"{get_column_letter(column_index)}{row_index}",
                        row_number=row_index,
                        column_name=str(header),
                        title="Отрицательное значение",
                        description=f"В колонке «{header}» найдено отрицательное значение {value}.",
                        suggested_fix="Проверьте знак числа и корректность возвратов или сторно.",
                        evidence={"value": value},
                    )
                )
    return findings[:40]


def _find_outliers(path: Path, sheet_name: str) -> list[Finding]:
    frame = pd.read_excel(path, sheet_name=sheet_name)
    findings: list[Finding] = []
    numeric_columns = frame.select_dtypes(include=[np.number]).columns
    for column in numeric_columns:
        series = frame[column].dropna()
        if len(series) < 8:
            continue
        sigma = float(pstdev(series))
        if sigma == 0:
            continue
        center = float(median(series))
        for index, value in series.items():
            z_score = abs((float(value) - center) / sigma)
            if z_score >= 3:
                findings.append(
                    Finding(
                        code="NUMERIC_OUTLIER",
                        severity="medium",
                        sheet_name=sheet_name,
                        row_number=int(index) + 2,
                        column_name=str(column),
                        title="Аномальное значение",
                        description=f"Значение {value} в колонке «{column}» сильно отличается от остальных.",
                        suggested_fix="Сверьте сумму с первичным документом, POS-системой или ведомостью.",
                        evidence={"value": float(value), "median": center, "z_score": round(z_score, 2)},
                    )
                )
    return findings[:40]


def _find_total_mismatches(sheet_name: str, ws_values: Any) -> list[Finding]:
    findings: list[Finding] = []
    for row_index in range(1, ws_values.max_row + 1):
        row_values = [ws_values.cell(row=row_index, column=col).value for col in range(1, ws_values.max_column + 1)]
        row_text = " ".join(str(value).lower() for value in row_values if isinstance(value, str))
        if not any(pattern in row_text for pattern in TOTAL_PATTERNS):
            continue
        numeric_cells = [
            (col, value)
            for col, value in enumerate(row_values, start=1)
            if isinstance(value, (int, float)) and not isinstance(value, bool)
        ]
        for col, total_value in numeric_cells:
            values_above = [ws_values.cell(row=row, column=col).value for row in range(max(1, row_index - 40), row_index)]
            numeric_above = [float(value) for value in values_above if isinstance(value, (int, float))]
            if len(numeric_above) >= 2:
                calculated = round(sum(numeric_above), 2)
                expected = round(float(total_value), 2)
                if abs(calculated - expected) > max(1.0, abs(expected) * 0.01):
                    findings.append(
                        Finding(
                            code="TOTAL_MISMATCH",
                            severity="critical",
                            sheet_name=sheet_name,
                            cell=f"{get_column_letter(col)}{row_index}",
                            row_number=row_index,
                            title="Итог не сходится",
                            description=f"Итог {expected} не совпадает с суммой строк выше {calculated}.",
                            suggested_fix="Проверьте диапазон формулы и строки, которые входят в итог.",
                            evidence={"expected": expected, "calculated": calculated},
                        )
                    )
    return findings[:30]


def _risk_score(findings: list[Finding]) -> int:
    weights = {"info": 1, "low": 3, "medium": 8, "high": 18, "critical": 30}
    return min(100, sum(weights.get(item.severity, 1) for item in findings))


def _risk_level(score: int) -> str:
    if score >= 75:
        return "critical"
    if score >= 45:
        return "high"
    if score >= 20:
        return "medium"
    return "low"


def _summary(findings: list[Finding], risk_level: str) -> str:
    if not findings:
        return "Критичных ошибок не найдено. Отчет выглядит согласованным по базовым проверкам."
    critical = sum(1 for item in findings if item.severity == "critical")
    high = sum(1 for item in findings if item.severity == "high")
    return f"Найдено {len(findings)} замечаний. Критичных: {critical}, высокого риска: {high}. Уровень риска: {risk_level}."


def _recommendations(findings: list[Finding]) -> list[str]:
    if not findings:
        return ["Сохраните PDF проверки и приложите его к месячному закрытию."]
    codes = {item.code for item in findings}
    recommendations = []
    if "TOTAL_MISMATCH" in codes:
        recommendations.append("Сначала исправьте итоговые строки: они влияют на зарплаты, премии и финансовый результат.")
    if "NEGATIVE_VALUE" in codes:
        recommendations.append("Проверьте отрицательные значения и отделите реальные возвраты от ошибок ввода.")
    if "REQUIRED_CELL_EMPTY" in codes:
        recommendations.append("Заполните обязательные поля, чтобы бухгалтерия могла сверить строки без ручных уточнений.")
    if "NUMERIC_OUTLIER" in codes:
        recommendations.append("Сверьте аномальные суммы с POS-системой и первичными документами.")
    if "FORMULA_NO_CACHED_VALUE" in codes or "FORMULA_SUSPICIOUS_SUM_RANGE" in codes:
        recommendations.append("Пересчитайте книгу в Excel и проверьте диапазоны формул перед финальной отправкой.")
    return recommendations[:5]

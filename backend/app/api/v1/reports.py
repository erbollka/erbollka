import shutil
import uuid
from datetime import date
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import get_settings
from app.db.models import AuditFinding, AuditReport, Severity
from app.db.session import get_db
from app.schemas.reports import (
    ComparisonMetricOut,
    FindingOut,
    ManagementReportOut,
    ReportChatRequest,
    ReportChatResponse,
    ReportComparisonOut,
    ReportOut,
)
from app.services.ai_reviewer import ask_ai_text, enrich_with_ai
from app.services.excel_analyzer import analyze_workbook
from app.services.pdf import build_report_pdf

router = APIRouter(prefix="/reports", tags=["reports"])


@router.post("/upload", response_model=ReportOut)
async def upload_report(
    store_id: uuid.UUID = Form(...),
    period_month: str = Form(...),
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
) -> ReportOut:
    if not file.filename or not file.filename.lower().endswith((".xlsx", ".xls")):
        raise HTTPException(status_code=400, detail="Only .xlsx and .xls files are supported")

    settings = get_settings()
    report_id = uuid.uuid4()
    suffix = Path(file.filename).suffix.lower()
    destination = settings.upload_dir / f"{report_id}{suffix}"
    with destination.open("wb") as handle:
        shutil.copyfileobj(file.file, handle)

    try:
        audit = analyze_workbook(destination)
        audit = await enrich_with_ai(audit)
        period = date.fromisoformat(f"{period_month}-01")
    except Exception as exc:
        destination.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail=f"Could not analyze workbook: {exc}") from exc

    report = AuditReport(
        id=report_id,
        store_id=store_id,
        period_month=period,
        file_name=file.filename,
        file_path=str(destination),
        file_sha256=audit.file_sha256,
        status="completed",
        risk_score=audit.risk_score,
        risk_level=audit.risk_level,
        summary=audit.summary,
        recommendations=audit.recommendations,
        workbook_profile=audit.workbook_profile,
    )
    report.findings = [
        AuditFinding(
            report_id=report_id,
            severity=Severity(item.severity),
            code=item.code,
            sheet_name=item.sheet_name,
            cell=item.cell,
            row_number=item.row_number,
            column_name=item.column_name,
            title=item.title,
            description=item.description,
            suggested_fix=item.suggested_fix,
            evidence=item.evidence,
            confidence=item.confidence,
        )
        for item in audit.findings
    ]
    db.add(report)
    await db.commit()
    await db.refresh(report, attribute_names=["findings"])
    return _report_out(report)


@router.get("", response_model=list[ReportOut])
async def list_reports(db: AsyncSession = Depends(get_db)) -> list[ReportOut]:
    result = await db.execute(
        select(AuditReport).options(selectinload(AuditReport.findings)).order_by(AuditReport.created_at.desc()).limit(20)
    )
    return [_report_out(report) for report in result.scalars().unique()]


@router.get("/{report_id}", response_model=ReportOut)
async def get_report(report_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> ReportOut:
    report = await _load_report(db, report_id)
    return _report_out(report)


@router.get("/{report_id}/compare", response_model=ReportComparisonOut)
async def compare_with_previous(report_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> ReportComparisonOut:
    report = await _load_report(db, report_id)
    previous_result = await db.execute(
        select(AuditReport)
        .where(AuditReport.store_id == report.store_id)
        .where(AuditReport.period_month < report.period_month)
        .options(selectinload(AuditReport.findings))
        .order_by(AuditReport.period_month.desc(), AuditReport.created_at.desc())
        .limit(1)
    )
    previous = previous_result.scalar_one_or_none()
    if not previous:
        return ReportComparisonOut(
            current_report_id=report.id,
            previous_report_id=None,
            summary="Предыдущий месяц для этого магазина пока не найден.",
            metrics=[],
        )

    metrics = [
        _comparison_metric("risk_score", float(report.risk_score), float(previous.risk_score)),
        _comparison_metric("total_findings", float(len(report.findings)), float(len(previous.findings))),
        _comparison_metric(
            "critical_findings",
            float(sum(1 for item in report.findings if item.severity.value == "critical")),
            float(sum(1 for item in previous.findings if item.severity.value == "critical")),
        ),
        _comparison_metric(
            "high_risk_findings",
            float(sum(1 for item in report.findings if item.severity.value in {"high", "critical"})),
            float(sum(1 for item in previous.findings if item.severity.value in {"high", "critical"})),
        ),
    ]
    current_totals = report.workbook_profile.get("metric_totals", {}) if report.workbook_profile else {}
    previous_totals = previous.workbook_profile.get("metric_totals", {}) if previous.workbook_profile else {}
    for metric_name in ("sales", "profit", "salary", "bonus", "expense"):
        if metric_name in current_totals or metric_name in previous_totals:
            metrics.append(
                _comparison_metric(
                    metric_name,
                    float(current_totals.get(metric_name) or 0),
                    float(previous_totals.get(metric_name) or 0),
                )
            )
    worse = [item for item in metrics if item.severity in {"medium", "high", "critical"} and item.delta_value > 0]
    summary = (
        "Показатели ухудшились относительно предыдущего месяца. Проверьте новые критичные и высокие риски."
        if worse
        else "Серьезного ухудшения относительно предыдущего месяца не видно."
    )
    return ReportComparisonOut(
        current_report_id=report.id,
        previous_report_id=previous.id,
        summary=summary,
        metrics=metrics,
    )


@router.get("/{report_id}/management-report", response_model=ManagementReportOut)
async def management_report(report_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> ManagementReportOut:
    report = await _load_report(db, report_id)
    payload = _report_payload(report)
    ai_text = await ask_ai_text(
        system=(
            "Ты финансовый аналитик и операционный advisor для fashion retail. "
            "Составь короткий, полезный отчет для руководства магазина на русском языке. "
            "Структура: главный вывод, финансовая картина, 3 главных риска, план действий на 7 дней. "
            "Используй только переданные KPI, summary, recommendations и findings. Не придумывай числа. "
            "Пиши конкретно: какие строки/типы ошибок проверить и почему это влияет на продажи, прибыль, скидки или возвраты."
        ),
        user_payload=payload,
    )
    highlights = _highlights(report)
    text = ai_text or _fallback_management_text(report, highlights)
    return ManagementReportOut(
        report_id=report.id,
        title=f"Отчет для руководства: {report.file_name}",
        text=text,
        highlights=highlights,
    )


@router.post("/{report_id}/chat", response_model=ReportChatResponse)
async def chat_with_report(
    report_id: uuid.UUID,
    request: ReportChatRequest,
    db: AsyncSession = Depends(get_db),
) -> ReportChatResponse:
    report = await _load_report(db, report_id)
    payload = _report_payload(report)
    ai_text = await ask_ai_text(
        system=(
            "Ты умный AI-аудитор и fashion retail assistant. Отвечай на вопрос пользователя на русском языке "
            "только по данным отчета. Давай не общий совет, а вывод, причины, приоритеты и следующие действия. "
            "Если данных не хватает, прямо скажи, что в загруженном файле этого не видно, и предложи, какой столбец/лист нужен. "
            "Не придумывай числа. Если вопрос про продажи, прибыль, скидки, возвраты или риски, связывай ответ с KPI и findings."
        ),
        user_payload={**payload, "question": request.question},
    )
    if ai_text:
        return ReportChatResponse(answer=ai_text, used_ai=True)
    return ReportChatResponse(answer=_fallback_chat_answer(report, request.question), used_ai=False)


@router.get("/{report_id}/pdf")
async def download_pdf(report_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> Response:
    report = await _load_report(db, report_id)
    pdf = build_report_pdf(report)
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{report.file_name}-audit.pdf"'},
    )


async def _load_report(db: AsyncSession, report_id: uuid.UUID) -> AuditReport:
    result = await db.execute(
        select(AuditReport).where(AuditReport.id == report_id).options(selectinload(AuditReport.findings))
    )
    report = result.scalar_one_or_none()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    return report


def _comparison_metric(metric_name: str, current: float, previous: float) -> ComparisonMetricOut:
    delta = current - previous
    delta_percent = None if previous == 0 else round(delta / previous * 100, 2)
    absolute_delta = abs(delta_percent if delta_percent is not None else delta)
    severity = "info"
    if absolute_delta >= 50:
        severity = "high"
    elif absolute_delta >= 25:
        severity = "medium"
    elif absolute_delta >= 10:
        severity = "low"
    return ComparisonMetricOut(
        metric_name=metric_name,
        current_value=current,
        previous_value=previous,
        delta_value=delta,
        delta_percent=delta_percent,
        severity=severity,
    )


def _report_payload(report: AuditReport) -> dict:
    return {
        "file_name": report.file_name,
        "risk_score": report.risk_score,
        "risk_level": report.risk_level,
        "summary": report.summary,
        "recommendations": report.recommendations,
        "workbook_profile": report.workbook_profile,
        "findings": [
            {
                "code": item.code,
                "severity": item.severity.value,
                "sheet": item.sheet_name,
                "cell": item.cell,
                "row_number": item.row_number,
                "title": item.title,
                "description": item.description,
                "suggested_fix": item.suggested_fix,
                "evidence": item.evidence,
            }
            for item in report.findings[:80]
        ],
    }


def _highlights(report: AuditReport) -> list[str]:
    totals = report.workbook_profile.get("metric_totals", {}) if report.workbook_profile else {}
    highlights = [
        f"Оценка качества отчета: {report.workbook_profile.get('quality_score', max(0, 100 - report.risk_score))}/100.",
        f"Найдено замечаний: {len(report.findings)}.",
    ]
    for label, key in (
        ("Продажи", "sales"),
        ("Прибыль", "profit"),
        ("Зарплаты", "salary"),
        ("Премии", "bonus"),
        ("Расходы", "expense"),
    ):
        value = totals.get(key)
        if value:
            highlights.append(f"{label}: {value:,.0f}.")
    return highlights[:6]


def _fallback_management_text(report: AuditReport, highlights: list[str]) -> str:
    top_findings = sorted(report.findings, key=lambda item: {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}.get(item.severity.value, 5))[:5]
    issues = " ".join(f"{item.title}: {item.description}" for item in top_findings)
    return (
        f"Автоматический аудит отчета «{report.file_name}» завершен. {report.summary} "
        f"Ключевые показатели: {' '.join(highlights)} "
        f"Главные замечания: {issues or 'существенных проблем не найдено'}"
    )


def _fallback_chat_answer(report: AuditReport, question: str) -> str:
    normalized = question.lower()
    totals = report.workbook_profile.get("metric_totals", {}) if report.workbook_profile else {}
    if "приб" in normalized:
        value = totals.get("profit")
        return f"В отчете показатель прибыли: {value}. Если прибыль снизилась, загрузите предыдущий месяц для сравнения." if value else "В загруженном отчете не найден отдельный показатель прибыли."
    if "прем" in normalized:
        bonus_findings = [item for item in report.findings if "BONUS" in item.code]
        return "По премиям найдено: " + "; ".join(item.description for item in bonus_findings[:5]) if bonus_findings else "Критичных замечаний по премиям не найдено."
    if "расход" in normalized:
        return f"Расходы в профиле отчета: {totals.get('expense', 0)}. Рекомендации: {' '.join(report.recommendations)}"
    if "подозр" in normalized or "мошен" in normalized:
        suspicious = [item for item in report.findings if item.code in {"SUSPICIOUS_DISCOUNT", "MONTH_END_RETURN_SPIKE", "BONUS_LIMIT_EXCEEDED", "DUPLICATE_ROW"}]
        return "Подозрительные операции: " + "; ".join(item.description for item in suspicious[:6]) if suspicious else "Подозрительных операций по текущим правилам не найдено."
    return f"{report.summary} Главные рекомендации: {' '.join(report.recommendations)}"


def _report_out(report: AuditReport) -> ReportOut:
    return ReportOut(
        id=report.id,
        file_name=report.file_name,
        status=report.status,
        risk_score=report.risk_score,
        risk_level=report.risk_level,
        total_findings=len(report.findings),
        summary=report.summary,
        recommendations=report.recommendations,
        workbook_profile=report.workbook_profile,
        created_at=report.created_at,
        findings=[
            FindingOut(
                code=item.code,
                severity=item.severity.value,
                sheet_name=item.sheet_name,
                cell=item.cell,
                row_number=item.row_number,
                column_name=item.column_name,
                title=item.title,
                description=item.description,
                suggested_fix=item.suggested_fix,
                evidence=item.evidence,
            )
            for item in report.findings
        ],
    )

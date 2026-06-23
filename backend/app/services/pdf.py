from io import BytesIO
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from app.db.models import AuditReport


def build_report_pdf(report: AuditReport) -> bytes:
    font_name = _register_unicode_font()
    buffer = BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=A4, title=f"Audit {report.file_name}")
    styles = getSampleStyleSheet()
    for style_name in ("Title", "Normal", "BodyText"):
        styles[style_name].fontName = font_name

    story = [
        Paragraph("Erbollka: отчет проверки", styles["Title"]),
        Paragraph(f"Файл: {report.file_name}", styles["Normal"]),
        Paragraph(f"Риск: {report.risk_level} ({report.risk_score}/100)", styles["Normal"]),
        Spacer(1, 12),
        Paragraph(report.summary, styles["BodyText"]),
        Spacer(1, 12),
    ]

    data = [["Риск", "Лист", "Ячейка", "Проблема", "Рекомендация"]]
    for finding in report.findings[:80]:
        data.append(
            [
                finding.severity.value,
                finding.sheet_name,
                finding.cell or "-",
                finding.description,
                finding.suggested_fix,
            ]
        )

    table = Table(data, colWidths=[55, 70, 45, 180, 160], repeatRows=1)
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#E7F3EF")),
                ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#CCCCCC")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("FONTNAME", (0, 0), (-1, -1), font_name),
                ("FONTSIZE", (0, 0), (-1, -1), 8),
            ]
        )
    )
    story.append(table)
    doc.build(story)
    return buffer.getvalue()


def _register_unicode_font() -> str:
    candidates = [
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
        Path("/usr/share/fonts/dejavu/DejaVuSans.ttf"),
        Path("C:/Windows/Fonts/arial.ttf"),
        Path("C:/Windows/Fonts/segoeui.ttf"),
    ]
    for path in candidates:
        if path.exists():
            pdfmetrics.registerFont(TTFont("RetailReportUnicode", str(path)))
            return "RetailReportUnicode"
    return "Helvetica"

import json
from typing import Any

from openai import AsyncOpenAI

from app.core.config import get_settings
from app.services.excel_analyzer import Finding, WorkbookAudit


AI_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "recommendations": {"type": "array", "items": {"type": "string"}},
        "finding_updates": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "code": {"type": "string"},
                    "description": {"type": "string"},
                    "suggested_fix": {"type": "string"}
                },
                "required": ["code", "description", "suggested_fix"],
                "additionalProperties": False
            }
        }
    },
    "required": ["summary", "recommendations", "finding_updates"],
    "additionalProperties": False
}


async def enrich_with_ai(audit: WorkbookAudit) -> WorkbookAudit:
    settings = get_settings()
    if not settings.openai_api_key or not audit.findings:
        return audit

    client = AsyncOpenAI(api_key=settings.openai_api_key)
    compact_findings = [
        {
            "code": item.code,
            "severity": item.severity,
            "sheet": item.sheet_name,
            "cell": item.cell,
            "description": item.description,
            "evidence": item.evidence,
        }
        for item in audit.findings[:60]
    ]
    try:
        response = await client.responses.create(
            model=settings.openai_model,
            input=[
                {
                    "role": "system",
                    "content": (
                        "Ты внимательный финансовый аудитор розничного магазина. "
                        "Объясняй найденные ошибки в Excel простым русским языком. "
                        "Не придумывай новые числа и факты; используй только переданные findings и evidence."
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps(
                        {
                            "workbook_profile": audit.workbook_profile,
                            "risk_level": audit.risk_level,
                            "findings": compact_findings,
                        },
                        ensure_ascii=False,
                    ),
                },
            ],
            text={
                "format": {
                    "type": "json_schema",
                    "name": "retail_excel_audit_explanation",
                    "strict": True,
                    "schema": AI_SCHEMA,
                }
            },
        )
        payload = json.loads(response.output_text)
    except Exception:
        return audit
    audit.summary = payload.get("summary") or audit.summary
    audit.recommendations = payload.get("recommendations") or audit.recommendations

    updates = {item["code"]: item for item in payload.get("finding_updates", [])}
    for finding in audit.findings:
        update = updates.get(finding.code)
        if update:
            finding.description = update["description"]
            finding.suggested_fix = update["suggested_fix"]
    return audit

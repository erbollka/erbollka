import json
from typing import Any

from openai import AsyncOpenAI

from app.core.config import get_settings
from app.services.excel_analyzer import WorkbookAudit


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
                    "suggested_fix": {"type": "string"},
                },
                "required": ["code", "description", "suggested_fix"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["summary", "recommendations", "finding_updates"],
    "additionalProperties": False,
}


async def enrich_with_ai(audit: WorkbookAudit) -> WorkbookAudit:
    settings = get_settings()
    if not settings.openai_api_key or not audit.findings:
        return audit

    payload = await ask_ai_json(
        system=(
            "Ты внимательный финансовый аудитор розничного магазина. "
            "Объясняй найденные ошибки в Excel простым русским языком. "
            "Не придумывай новые числа и факты; используй только переданные findings, KPI и evidence."
        ),
        user_payload={
            "workbook_profile": audit.workbook_profile,
            "risk_level": audit.risk_level,
            "findings": [
                {
                    "code": item.code,
                    "severity": item.severity,
                    "sheet": item.sheet_name,
                    "cell": item.cell,
                    "description": item.description,
                    "evidence": item.evidence,
                }
                for item in audit.findings[:60]
            ],
        },
        schema=AI_SCHEMA,
        schema_name="retail_excel_audit_explanation",
    )
    if not payload:
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


async def ask_ai_text(system: str, user_payload: dict[str, Any]) -> str | None:
    settings = get_settings()
    if not settings.openai_api_key:
        return None
    try:
        client = AsyncOpenAI(api_key=settings.openai_api_key)
        response = await client.responses.create(
            model=settings.openai_model,
            input=[
                {"role": "system", "content": system},
                {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)},
            ],
        )
        return response.output_text
    except Exception:
        return None


async def ask_ai_json(system: str, user_payload: dict[str, Any], schema: dict[str, Any], schema_name: str) -> dict[str, Any] | None:
    settings = get_settings()
    if not settings.openai_api_key:
        return None
    try:
        client = AsyncOpenAI(api_key=settings.openai_api_key)
        response = await client.responses.create(
            model=settings.openai_model,
            input=[
                {"role": "system", "content": system},
                {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)},
            ],
            text={"format": {"type": "json_schema", "name": schema_name, "strict": True, "schema": schema}},
        )
        return json.loads(response.output_text)
    except Exception:
        return None

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field


class FindingOut(BaseModel):
    code: str
    severity: str
    sheet_name: str
    cell: str | None
    row_number: int | None
    column_name: str | None
    title: str
    description: str
    suggested_fix: str
    evidence: dict = Field(default_factory=dict)


class ReportOut(BaseModel):
    id: UUID
    file_name: str
    status: str
    risk_score: int
    risk_level: str
    total_findings: int
    summary: str
    recommendations: list[str]
    workbook_profile: dict = Field(default_factory=dict)
    findings: list[FindingOut]
    created_at: datetime


class ComparisonMetricOut(BaseModel):
    metric_name: str
    current_value: float
    previous_value: float
    delta_value: float
    delta_percent: float | None
    severity: str


class ReportComparisonOut(BaseModel):
    current_report_id: UUID
    previous_report_id: UUID | None
    summary: str
    metrics: list[ComparisonMetricOut]


class ReportChatRequest(BaseModel):
    question: str


class ReportChatResponse(BaseModel):
    answer: str
    used_ai: bool = False


class ManagementReportOut(BaseModel):
    report_id: UUID
    title: str
    text: str
    highlights: list[str]

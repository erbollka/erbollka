import enum
import uuid
from datetime import datetime

from sqlalchemy import Date, DateTime, Enum, ForeignKey, Integer, JSON, Numeric, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class Role(str, enum.Enum):
    director = "director"
    accountant = "accountant"
    admin = "admin"


class Severity(str, enum.Enum):
    info = "info"
    low = "low"
    medium = "medium"
    high = "high"
    critical = "critical"


class Organization(Base):
    __tablename__ = "organizations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)

    stores: Mapped[list["Store"]] = relationship(back_populates="organization")


class Store(Base):
    __tablename__ = "stores"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    code: Mapped[str] = mapped_column(String(64), nullable=False)

    organization: Mapped[Organization] = relationship(back_populates="stores")


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False)
    email: Mapped[str] = mapped_column(String(320), nullable=False, unique=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[Role] = mapped_column(Enum(Role, name="user_role"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)


class AuditReport(Base):
    __tablename__ = "audit_reports"
    __table_args__ = (UniqueConstraint("store_id", "period_month", "file_sha256", name="uq_report_file_per_month"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    store_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("stores.id", ondelete="CASCADE"), nullable=False)
    uploaded_by_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    period_month: Mapped[datetime] = mapped_column(Date, nullable=False)
    file_name: Mapped[str] = mapped_column(String(255), nullable=False)
    file_path: Mapped[str] = mapped_column(String(500), nullable=False)
    file_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(40), default="completed", nullable=False)
    risk_score: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    risk_level: Mapped[str] = mapped_column(String(20), default="low", nullable=False)
    summary: Mapped[str] = mapped_column(Text, default="", nullable=False)
    recommendations: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    workbook_profile: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)

    findings: Mapped[list["AuditFinding"]] = relationship(back_populates="report", cascade="all, delete-orphan")


class AuditFinding(Base):
    __tablename__ = "audit_findings"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    report_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("audit_reports.id", ondelete="CASCADE"), nullable=False)
    severity: Mapped[Severity] = mapped_column(Enum(Severity, name="finding_severity"), nullable=False)
    code: Mapped[str] = mapped_column(String(80), nullable=False)
    sheet_name: Mapped[str] = mapped_column(String(160), nullable=False)
    cell: Mapped[str | None] = mapped_column(String(40))
    row_number: Mapped[int | None] = mapped_column(Integer)
    column_name: Mapped[str | None] = mapped_column(String(160))
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    suggested_fix: Mapped[str] = mapped_column(Text, nullable=False)
    evidence: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    confidence: Mapped[float] = mapped_column(Numeric(4, 3), default=0.85, nullable=False)

    report: Mapped[AuditReport] = relationship(back_populates="findings")


class ReportComparison(Base):
    __tablename__ = "report_comparisons"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    current_report_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("audit_reports.id", ondelete="CASCADE"), nullable=False)
    previous_report_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("audit_reports.id", ondelete="CASCADE"), nullable=False)
    metric_name: Mapped[str] = mapped_column(String(160), nullable=False)
    current_value: Mapped[float | None] = mapped_column(Numeric)
    previous_value: Mapped[float | None] = mapped_column(Numeric)
    delta_value: Mapped[float | None] = mapped_column(Numeric)
    delta_percent: Mapped[float | None] = mapped_column(Numeric)
    severity: Mapped[Severity] = mapped_column(Enum(Severity, name="finding_severity"), default=Severity.info, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)

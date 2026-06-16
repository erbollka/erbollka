create extension if not exists "uuid-ossp";

create type user_role as enum ('director', 'accountant', 'admin');
create type finding_severity as enum ('info', 'low', 'medium', 'high', 'critical');

create table organizations (
  id uuid primary key default uuid_generate_v4(),
  name varchar(160) not null,
  created_at timestamptz not null default now()
);

create table stores (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name varchar(160) not null,
  code varchar(64) not null,
  created_at timestamptz not null default now(),
  unique (organization_id, code)
);

create table users (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  email varchar(320) not null unique,
  password_hash varchar(255) not null,
  role user_role not null,
  created_at timestamptz not null default now()
);

create table audit_reports (
  id uuid primary key default uuid_generate_v4(),
  store_id uuid not null references stores(id) on delete cascade,
  uploaded_by_user_id uuid references users(id) on delete set null,
  period_month date not null,
  file_name varchar(255) not null,
  file_path varchar(500) not null,
  file_sha256 char(64) not null,
  status varchar(40) not null default 'completed',
  risk_score integer not null default 0 check (risk_score between 0 and 100),
  risk_level varchar(20) not null default 'low',
  summary text not null default '',
  recommendations jsonb not null default '[]'::jsonb,
  workbook_profile jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (store_id, period_month, file_sha256)
);

create table audit_findings (
  id uuid primary key default uuid_generate_v4(),
  report_id uuid not null references audit_reports(id) on delete cascade,
  severity finding_severity not null,
  code varchar(80) not null,
  sheet_name varchar(160) not null,
  cell varchar(40),
  row_number integer,
  column_name varchar(160),
  title varchar(255) not null,
  description text not null,
  suggested_fix text not null,
  evidence jsonb not null default '{}'::jsonb,
  confidence numeric(4,3) not null default 0.850,
  created_at timestamptz not null default now()
);

create table report_comparisons (
  id uuid primary key default uuid_generate_v4(),
  current_report_id uuid not null references audit_reports(id) on delete cascade,
  previous_report_id uuid not null references audit_reports(id) on delete cascade,
  metric_name varchar(160) not null,
  current_value numeric,
  previous_value numeric,
  delta_value numeric,
  delta_percent numeric,
  severity finding_severity not null default 'info',
  created_at timestamptz not null default now()
);

create index idx_reports_store_period on audit_reports(store_id, period_month desc);
create index idx_findings_report_severity on audit_findings(report_id, severity);

insert into organizations (id, name)
values ('00000000-0000-0000-0000-000000000001', 'Demo Fashion Group')
on conflict do nothing;

insert into stores (id, organization_id, name, code)
values (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  'Max Mara Demo Store',
  'MAX-MARA-DEMO'
)
on conflict do nothing;

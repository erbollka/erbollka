# Erbollka architecture

## Цель

Erbollka проверяет Excel-отчеты розничных магазинов: продажи, зарплаты, премии, остатки, расходы, итоги и подозрительные отклонения. Детерминированные проверки выполняются кодом, а AI объясняет уже найденные факты простым языком и предлагает исправления.

## Архитектура

- Frontend: Vite, React, TypeScript.
- Backend: FastAPI, pandas, openpyxl, SQLAlchemy async.
- AI: OpenAI Responses API со structured outputs.
- Database: PostgreSQL.
- Storage: локальная папка в MVP, затем S3/R2/MinIO.
- PDF: server-side генерация через ReportLab.

## Структура папок

```text
src/
  App.tsx                   рабочий UI проверки отчетов
  index.css                 стили Vite-приложения
  lib/api.ts                клиент FastAPI
backend/
  app/api/v1/               REST endpoints
  app/core/                 settings
  app/db/                   SQLAlchemy models/session
  app/schemas/              Pydantic DTO
  app/services/             Excel analyzer, AI reviewer, PDF
infra/
  schema.sql                PostgreSQL schema и demo seed
docs/
  ARCHITECTURE.md           архитектура, roadmap, SaaS notes
docker-compose.yml          локальный запуск PostgreSQL + API + UI
```

## Поток данных

1. Директор загружает `.xlsx` или `.xls`.
2. Backend сохраняет файл и считает SHA-256.
3. Excel analyzer читает все листы, строит профиль книги и запускает проверки.
4. AI reviewer получает компактный JSON: профиль, риск и findings. Полный Excel в модель не отправляется.
5. Backend сохраняет отчет и найденные проблемы.
6. Frontend показывает риск, рекомендации, таблицу проблем, историю, сравнение с прошлым месяцем и ссылку на PDF.

## Database schema

Основные таблицы:

- `organizations`: сеть или юридическое лицо.
- `stores`: магазины внутри организации.
- `users`: директор, бухгалтер, администратор.
- `audit_reports`: факт проверки файла, риск, summary, workbook profile.
- `audit_findings`: ошибки и подозрительные строки.
- `report_comparisons`: кэш сравнений между месяцами для будущих фоновых задач.

Полная SQL-схема находится в `infra/schema.sql`.

## API endpoints

- `GET /health`: health check.
- `POST /api/v1/reports/upload`: загрузка и проверка Excel.
- `GET /api/v1/reports`: история последних проверок.
- `GET /api/v1/reports/{report_id}`: отчет проверки.
- `GET /api/v1/reports/{report_id}/compare`: сравнение с предыдущим месяцем магазина.
- `GET /api/v1/reports/{report_id}/pdf`: PDF-отчет.

Planned:

- `POST /api/v1/auth/login`
- `GET /api/v1/stores`
- `POST /api/v1/stores`
- `GET /api/v1/analytics/anomalies`
- `GET /api/v1/admin/users`

## Проверки Excel

- Чтение всех листов.
- Профиль структуры таблиц.
- Формулы без сохраненного результата.
- Подозрительные `SUM` диапазоны.
- Пустые обязательные ячейки.
- Дубликаты строк.
- Отрицательные значения в продажах, зарплатах, премиях, остатках и расходах.
- Статистические выбросы в числовых колонках.
- Несовпадение итоговой строки с суммой строк выше.

## MVP roadmap на 30 дней

Дни 1-5:

- Поднять Vite, FastAPI, PostgreSQL.
- Реализовать загрузку Excel и чтение всех листов.
- Сохранять историю проверок.

Дни 6-10:

- Проверки пустых обязательных ячеек, дублей и отрицательных значений.
- Базовый риск-скоринг.
- UI списка ошибок.

Дни 11-15:

- Проверки формул и итогов.
- PDF-отчет.
- Улучшение распознавания структуры таблиц.

Дни 16-20:

- OpenAI explanations через structured outputs.
- Сравнение с предыдущим месяцем.
- Настройки правил по магазину.

Дни 21-25:

- Авторизация и роли: директор, бухгалтер, администратор.
- Поддержка нескольких магазинов.
- Tenant guard по организации.

Дни 26-30:

- Тесты анализатора на реальных обезличенных шаблонах.
- Docker deployment.
- UX-полировка, обработка больших файлов, документация.

## Лучшие практики AI-анализа Excel

- Сначала считать проверяемые факты кодом, затем отдавать AI только findings и агрегаты.
- Использовать structured outputs с JSON schema, чтобы UI получал стабильный формат.
- Не отправлять полный Excel в модель без необходимости; минимизировать персональные данные.
- Не позволять AI менять числовые выводы анализатора. Модель объясняет, группирует и предлагает действия.
- Версионировать prompt и модель, сохранять их в metadata отчета.
- Делать eval-набор из обезличенных отчетов: корректный файл, ошибка итога, пустые поля, дубли, выбросы.
- Логировать latency, token usage, долю fallback без AI и ручные исправления пользователей.

## Масштабирование до SaaS

- Multi-tenant модель: каждая запись привязана к `organization_id`; в production добавить RLS или строгий application-level tenant guard.
- Background jobs: Celery/RQ/Arq для больших файлов, статусы `queued`, `processing`, `completed`, `failed`.
- Object storage: S3/R2/MinIO вместо локальной папки.
- Rule engine: правила по бренду, магазину, типу отчета и стране.
- Billing: тарифы по числу магазинов, проверок, пользователей и сроку хранения.
- Audit trail: кто загрузил файл, скачал PDF, подтвердил исправление.
- Privacy: шифрование файлов, retention policy, удаление PII, отдельные ключи для enterprise-клиентов.

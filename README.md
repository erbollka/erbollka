# Retail Report AI

AI-приложение для автоматической проверки Excel-отчетов розничных магазинов: продажи, зарплаты, премии, остатки, расходы, итоговые суммы, бизнес-риски и подозрительные операции.

Публичный сайт: https://erbollka.github.io/erbollka/

## Стек

- Frontend: Vite, React, TypeScript.
- Backend: Python FastAPI.
- Excel: pandas, openpyxl, xlrd.
- AI: OpenAI API.
- Database: PostgreSQL.
- Deploy: GitHub Pages, Vercel-ready.

## Реализовано в MVP

- Загрузка `.xlsx` и `.xls`.
- Автоматическое чтение всех листов.
- Проверка формул.
- Поиск пустых обязательных ячеек.
- Поиск дубликатов.
- Проверка итоговых сумм.
- Автоматический отчет об ошибках.
- Оценка качества отчета от 0 до 100.
- KPI-дашборд: продажи, прибыль, зарплаты, премии, расходы, скидки, возвраты.
- Бизнес-логика: премии выше лимита, расходы на персонал выше нормы, расходы выше нормы.
- Контроль мошенничества: необычные премии, подозрительные скидки, возвраты перед закрытием месяца, дубли операций.
- Сравнение с предыдущим месяцем.
- AI-чат с отчетом.
- Кнопка “Создать отчет для руководства”.
- PDF-отчет.

## Структура

```text
src/                 Vite React приложение
backend/             FastAPI API и Excel-анализатор
infra/schema.sql     PostgreSQL schema
docs/ARCHITECTURE.md архитектура, endpoints, roadmap, SaaS notes
docker-compose.yml   локальный запуск всего MVP
```

## Быстрый запуск

```bash
docker compose up
```

После запуска:

- UI: http://localhost:3000
- API: http://localhost:8000
- Swagger: http://localhost:8000/docs

Для AI-объяснений добавьте `OPENAI_API_KEY` в `backend/.env`. Без ключа приложение продолжит работать на детерминированных проверках.

## Документация

См. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

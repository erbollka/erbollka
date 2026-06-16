# Retail Report AI

AI-приложение для автоматической проверки Excel-отчетов розничных магазинов: продажи, зарплаты, премии, остатки, расходы, итоги и аномалии.

## Стек

- Frontend: Vite, React, TypeScript.
- Backend: Python FastAPI.
- Excel: pandas, openpyxl, xlrd.
- AI: OpenAI API.
- Database: PostgreSQL.

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

## Что реализовано

- Загрузка `.xlsx` и `.xls`.
- Автоматическое чтение всех листов.
- Профилирование структуры книги.
- Проверка формул, пустых обязательных ячеек, дублей, отрицательных значений, выбросов и итогов.
- AI-обогащение отчета через OpenAI Responses API при наличии ключа.
- История проверок.
- Сравнение отчета с предыдущим месяцем.
- PDF-отчет.
- Базовая multi-store schema и роли.

## Документация

См. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

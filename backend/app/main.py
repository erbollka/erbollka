from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1.reports import router as reports_router
from app.core.config import get_settings

settings = get_settings()

app = FastAPI(
    title="Retail Report AI API",
    version="0.1.0",
    description="Automated Excel report audit API for retail stores.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


app.include_router(reports_router, prefix="/api/v1")

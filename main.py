"""镜界 · 小说漫剧工作台 - 本地运行版本入口."""
import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

from core.database import init_db, SessionLocal
from core.seed import seed
from routes import auth, system, projects, admin

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="镜界 · 小说漫剧工作台", version="1.0.0-local")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register API routes
app.include_router(auth.router, prefix="/api")
app.include_router(system.router, prefix="/api")
app.include_router(projects.router, prefix="/api")
app.include_router(admin.router, prefix="/api")


@app.on_event("startup")
def on_startup():
    init_db()
    db = SessionLocal()
    try:
        seed(db)
    finally:
        db.close()


# Mount static assets under /static (matching index.html references)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


def _serve_index():
    return FileResponse(str(STATIC_DIR / "index.html"))


@app.get("/")
def index():
    return _serve_index()


# SPA fallback: any non-API, non-static path returns index.html
@app.get("/{full_path:path}")
def spa_fallback(full_path: str):
    if full_path.startswith("api/") or full_path.startswith("static/"):
        return JSONResponse({"detail": "Not Found"}, status_code=404)
    return _serve_index()


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8765))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)

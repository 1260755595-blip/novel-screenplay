"""Project routes: CRUD, run, episodes, generations, download."""
import io
import math
import urllib.parse
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import desc
from sqlalchemy.orm import Session

from core.database import get_db
from core.models import User, Project, Job, Episode, WorkflowVersion, OneShotVersion
from core.auth import get_current_user
from core.generator import start_generation
from core.seed import get_config_value

router = APIRouter()


def _job_to_dict(job: Job) -> dict:
    return {
        "id": job.id,
        "status": job.status,
        "stage": job.stage,
        "progress": job.progress,
        "current_batch": job.current_batch,
        "total_batches": job.total_batches,
        "completed_episodes": job.completed_episodes,
        "total_episodes": job.total_episodes,
        "error": job.error,
        "events": job.events or [],
    }


def _project_to_dict(p: Project, db: Session, include_generation_inputs: bool = False, generation_job_id: int = None) -> dict:
    latest_job = db.query(Job).filter(Job.project_id == p.id).order_by(desc(Job.id)).first()
    # generations list
    jobs = db.query(Job).filter(Job.project_id == p.id).order_by(Job.id.asc()).all()
    generations = []
    for j in jobs:
        ep_count = db.query(Episode).filter(Episode.job_id == j.id).count()
        generations.append({
            "job_id": j.id,
            "version_no": j.version_no,
            "episode_count": ep_count,
            "is_current": j.id == p.current_generation_job_id,
            "created_at": j.created_at.isoformat() if j.created_at else None,
            "finished_at": j.finished_at.isoformat() if j.finished_at else None,
        })

    selected_gid = generation_job_id or p.selected_generation_job_id or p.current_generation_job_id
    episodes = []
    if selected_gid:
        eps = db.query(Episode).filter(
            Episode.project_id == p.id, Episode.job_id == selected_gid
        ).order_by(Episode.episode_no.asc()).all()
        episodes = [{"episode_no": e.episode_no, "status": e.status, "review": e.review or ""} for e in eps]

    data = {
        "id": p.id,
        "user_id": p.user_id,
        "title": p.title,
        "source_filename": p.source_filename,
        "novel_type": p.novel_type,
        "chapter_count": p.chapter_count,
        "target_episode_count": p.target_episode_count,
        "batch_count": p.batch_count,
        "batch_size": p.batch_size,
        "split_mode": p.split_mode,
        "status": p.status,
        "workflow_version_id": p.workflow_version_id,
        "one_shot_version_id": p.one_shot_version_id,
        "workflow_version_name": p.workflow_version_name,
        "one_shot_version_name": p.one_shot_version_name,
        "generation_count": p.generation_count or 0,
        "episode_count": p.episode_count or 0,
        "current_generation_job_id": p.current_generation_job_id,
        "selected_generation_job_id": selected_gid,
        "latest_job": _job_to_dict(latest_job) if latest_job else None,
        "generations": generations,
        "episodes": episodes,
        "created_at": p.created_at.isoformat() if p.created_at else None,
        "updated_at": p.updated_at.isoformat() if p.updated_at else None,
    }
    if include_generation_inputs:
        data["generation_inputs"] = {
            "version_id": p.generation_inputs_version_id,
            "workflow_files": p.generation_inputs_workflow_files or {},
            "quality_settings": p.generation_inputs_quality or {},
            "context": p.generation_inputs_context or "",
            "editable": bool(p.generation_inputs_editable),
        }
    return data


@router.get("/projects")
def list_projects(
    page: int = Query(1, ge=1),
    page_size: int = Query(10, ge=1, le=100),
    search: str = "",
    novel_type: str = "",
    status: str = "",
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    q = db.query(Project)
    if user.role == "user":
        q = q.filter(Project.user_id == user.id)
    if search:
        q = q.filter(Project.title.contains(search))
    if novel_type:
        q = q.filter(Project.novel_type == novel_type)
    if status:
        q = q.filter(Project.status == status)
    total = q.count()
    projects = q.order_by(desc(Project.id)).offset((page - 1) * page_size).limit(page_size).all()
    total_pages = max(1, math.ceil(total / page_size))
    types = [r[0] for r in db.query(Project.novel_type).distinct().all() if r[0]]
    return {
        "projects": [_project_to_dict(p, db) for p in projects],
        "pagination": {"page": page, "page_size": page_size, "total": total, "total_pages": total_pages},
        "filter_options": {"novel_types": types},
    }


@router.post("/projects")
async def create_project(
    title: str = Form(""),
    novel_type: str = Form("自动识别"),
    target_episode_count: int = Form(0),
    workflow_version_id: int = Form(None),
    one_shot_version_id: int = Form(None),
    file: UploadFile = File(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    content = ""
    filename = ""
    if file:
        raw = await file.read()
        filename = file.filename or "novel.txt"
        try:
            content = raw.decode("utf-8")
        except UnicodeDecodeError:
            content = raw.decode("utf-8", errors="replace")
    if not title and filename:
        title = filename.rsplit(".", 1)[0]
    if not title:
        title = "未命名项目"

    wf = db.query(WorkflowVersion).filter(WorkflowVersion.id == workflow_version_id).first()
    os_ver = db.query(OneShotVersion).filter(OneShotVersion.id == one_shot_version_id).first()

    project = Project(
        user_id=user.id,
        title=title,
        source_filename=filename,
        novel_type=novel_type or "自动识别",
        raw_content=content,
        chapter_count=0,
        target_episode_count=target_episode_count,
        batch_count=1,
        batch_size=int(get_config_value(db, "batch_size", "6")),
        split_mode="auto",
        status="ready",
        workflow_version_id=wf.id if wf else None,
        one_shot_version_id=os_ver.id if os_ver else None,
        workflow_version_name=wf.name if wf else "",
        one_shot_version_name=os_ver.name if os_ver else "",
        generation_inputs_version_id=os_ver.id if os_ver else None,
        generation_inputs_workflow_files=(os_ver.workflow_files or {}) if os_ver else {},
        generation_inputs_quality=(os_ver.quality_settings or {}) if os_ver else {},
        generation_inputs_context=(os_ver.default_context or "") if os_ver else "",
        generation_inputs_editable=True,
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return {"project": _project_to_dict(project, db)}


@router.get("/projects/{project_id}")
def get_project(
    project_id: int,
    include_generation_inputs: int = Query(0),
    generation_job_id: int = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="项目不存在")
    if user.role == "user" and project.user_id != user.id:
        raise HTTPException(status_code=403, detail="无权限")
    return {"project": _project_to_dict(project, db, include_generation_inputs=bool(include_generation_inputs), generation_job_id=generation_job_id)}


@router.delete("/projects/{project_id}")
def delete_project(project_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="项目不存在")
    if project.user_id != user.id and user.role != "admin":
        raise HTTPException(status_code=403, detail="无权限")
    if project.status in ("running", "queued"):
        raise HTTPException(status_code=400, detail="任务进行中，请先暂停")
    db.delete(project)
    db.commit()
    return {"ok": True}


@router.get("/projects/{project_id}/generation-inputs")
def get_generation_inputs(project_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="项目不存在")
    if project.user_id != user.id and user.role != "admin":
        raise HTTPException(status_code=403, detail="无权限")
    return {
        "generation_inputs": {
            "version_id": project.generation_inputs_version_id,
            "workflow_files": project.generation_inputs_workflow_files or {},
            "quality_settings": project.generation_inputs_quality or {},
            "context": project.generation_inputs_context or "",
            "editable": bool(project.generation_inputs_editable),
        }
    }


@router.patch("/projects/{project_id}/generation-inputs")
def update_generation_inputs(
    project_id: int,
    body: dict,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="项目不存在")
    if project.user_id != user.id and user.role != "admin":
        raise HTTPException(status_code=403, detail="无权限")
    if not project.generation_inputs_editable:
        raise HTTPException(status_code=400, detail="当前状态不能修改 AI 输入")
    project.generation_inputs_version_id = body.get("version_id", project.generation_inputs_version_id)
    project.generation_inputs_workflow_files = body.get("workflow_files", project.generation_inputs_workflow_files)
    project.generation_inputs_quality = body.get("quality_settings", project.generation_inputs_quality)
    project.generation_inputs_context = body.get("context", project.generation_inputs_context)
    project.generation_inputs_editable = True
    db.commit()
    return {
        "generation_inputs": {
            "version_id": project.generation_inputs_version_id,
            "workflow_files": project.generation_inputs_workflow_files,
            "quality_settings": project.generation_inputs_quality,
            "context": project.generation_inputs_context,
            "editable": True,
        }
    }


@router.post("/projects/{project_id}/run")
def run_project(project_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="项目不存在")
    if project.user_id != user.id and user.role != "admin":
        raise HTTPException(status_code=403, detail="无权限")
    if project.status in ("running", "queued"):
        raise HTTPException(status_code=400, detail="任务已在运行")
    if not project.raw_content:
        raise HTTPException(status_code=400, detail="小说内容为空，请重新上传")
    api_key = get_config_value(db, "ai_api_key")
    # In local mode, allow mock generation even without key
    job = start_generation(db, project)
    user.monthly_runs = (user.monthly_runs or 0) + 1
    db.commit()
    from routes.auth import user_to_dict
    return {"ok": True, "job_id": job.id, "user": user_to_dict(user)}


@router.delete("/projects/{project_id}/generations/{job_id}")
def delete_generation(project_id: int, job_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="项目不存在")
    if project.user_id != user.id and user.role != "admin":
        raise HTTPException(status_code=403, detail="无权限")
    job = db.query(Job).filter(Job.id == job_id, Job.project_id == project_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="版本不存在")
    db.query(Episode).filter(Episode.job_id == job_id).delete()
    db.delete(job)
    # recompute current/selected
    remaining = db.query(Job).filter(Job.project_id == project_id).order_by(desc(Job.id)).all()
    if remaining:
        project.current_generation_job_id = remaining[0].id
        project.selected_generation_job_id = remaining[0].id
    else:
        project.current_generation_job_id = None
        project.selected_generation_job_id = None
        project.status = "ready"
        project.episode_count = 0
    project.generation_count = len(remaining)
    db.commit()
    return {"ok": True}


@router.delete("/projects/{project_id}/generations")
def delete_all_generations(project_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="项目不存在")
    if project.user_id != user.id and user.role != "admin":
        raise HTTPException(status_code=403, detail="无权限")
    jobs = db.query(Job).filter(Job.project_id == project_id).all()
    for j in jobs:
        db.query(Episode).filter(Episode.job_id == j.id).delete()
        db.delete(j)
    project.current_generation_job_id = None
    project.selected_generation_job_id = None
    project.generation_count = 0
    project.episode_count = 0
    project.status = "ready"
    db.commit()
    return {"ok": True}


@router.get("/projects/{project_id}/episodes/{episode_no}")
def get_episode(
    project_id: int,
    episode_no: int,
    generation_job_id: int = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="项目不存在")
    if user.role == "user" and project.user_id != user.id:
        raise HTTPException(status_code=403, detail="无权限")
    gid = generation_job_id or project.selected_generation_job_id or project.current_generation_job_id
    ep = db.query(Episode).filter(
        Episode.project_id == project_id,
        Episode.job_id == gid,
        Episode.episode_no == episode_no,
    ).first()
    if not ep:
        raise HTTPException(status_code=404, detail="剧集不存在")
    return {"episode": {"episode_no": ep.episode_no, "status": ep.status, "content": ep.content, "review": ep.review}}


@router.get("/projects/{project_id}/breakdown")
def get_breakdown(
    project_id: int,
    generation_job_id: int = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="项目不存在")
    if user.role == "user" and project.user_id != user.id:
        raise HTTPException(status_code=403, detail="无权限")
    gid = generation_job_id or project.selected_generation_job_id or project.current_generation_job_id
    job = db.query(Job).filter(Job.id == gid, Job.project_id == project_id).first() if gid else None
    return {"content": (job.breakdown if job else "") or ""}


@router.get("/projects/{project_id}/download-word")
def download_word(
    project_id: int,
    generation_job_id: int = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="项目不存在")
    if user.role == "user" and project.user_id != user.id:
        raise HTTPException(status_code=403, detail="无权限")
    gid = generation_job_id or project.selected_generation_job_id or project.current_generation_job_id
    eps = db.query(Episode).filter(
        Episode.project_id == project_id, Episode.job_id == gid
    ).order_by(Episode.episode_no.asc()).all()
    text = f"《{project.title}》剧本\n\n"
    for ep in eps:
        text += f"\n\n{'=' * 50}\n第 {ep.episode_no} 集\n{'=' * 50}\n\n{ep.content}\n"
    buf = io.BytesIO(text.encode("utf-8"))
    buf.seek(0)
    safe_name = urllib.parse.quote(f"{project.title}.doc")
    return StreamingResponse(
        buf,
        media_type="application/msword",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{safe_name}"},
    )


@router.post("/jobs/{job_id}/pause")
def pause_job(job_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    job = db.query(Job).filter(Job.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="任务不存在")
    project = db.query(Project).filter(Project.id == job.project_id).first()
    if project and project.user_id != user.id and user.role != "admin":
        raise HTTPException(status_code=403, detail="无权限")
    job.status = "paused"
    if project:
        project.status = "paused"
    db.commit()
    return {"message": "任务已安全暂停"}

"""Admin routes: users, tasks, audit, settings, workflow & one-shot management."""
import json
import math
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import desc
from sqlalchemy.orm import Session

from core.database import get_db
from core.models import User, Job, Project, WorkflowVersion, OneShotVersion, AuditLog, SystemConfig
from core.auth import get_current_user, require_admin, require_management, hash_password
from core.seed import (
    get_config_value, set_config_value, DEFAULT_QUALITY, DEFAULT_PROMPTS, DEFAULT_PROMPT_MODES,
    load_workflow_files,
)
from routes.auth import user_to_dict
from routes.system import _wf_to_dict, _os_to_dict

router = APIRouter()


def _add_audit(db: Session, user: User, action: str, target_type: str = "", target_id: int = None, summary: str = ""):
    db.add(AuditLog(
        user_id=user.id, action=action, target_type=target_type,
        target_id=target_id, summary=summary,
    ))
    db.commit()


# ---------- Users ----------
@router.get("/admin/users")
def list_users(db: Session = Depends(get_db), user: User = Depends(require_management)):
    users = db.query(User).order_by(User.id.asc()).all()
    return {"users": [user_to_dict(u) for u in users]}


@router.post("/admin/users")
def create_user(body: dict, db: Session = Depends(get_db), user: User = Depends(require_management)):
    username = (body.get("username") or "").strip()
    password = body.get("password") or ""
    if not username or not password:
        raise HTTPException(status_code=400, detail="用户名和密码不能为空")
    if db.query(User).filter(User.username == username).first():
        raise HTTPException(status_code=400, detail="用户名已存在")
    role = body.get("role", "user")
    if role not in ("admin", "manager", "user"):
        role = "user"
    if user.role != "admin" and role != "user":
        raise HTTPException(status_code=403, detail="仅管理员可创建管理账号")
    new_user = User(
        username=username,
        display_name=body.get("display_name") or username,
        password_hash=hash_password(password),
        role=role,
        max_monthly_runs=int(body.get("max_monthly_runs", 100)),
        max_projects=int(body.get("max_projects", 50)),
        max_active_jobs=int(body.get("max_active_jobs", 3)),
        max_chapters_per_project=int(body.get("max_chapters_per_project", 500)),
    )
    db.add(new_user)
    db.commit()
    _add_audit(db, user, "create_user", "user", new_user.id, f"创建账号 {username}")
    return {"user": user_to_dict(new_user)}


@router.patch("/admin/users/{user_id}")
def update_user(user_id: int, body: dict, db: Session = Depends(get_db), user: User = Depends(require_management)):
    target = db.query(User).filter(User.id == user_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="用户不存在")
    if user.role != "admin" and target.role != "user":
        raise HTTPException(status_code=403, detail="仅管理员可编辑管理账号")
    if "display_name" in body:
        target.display_name = body["display_name"]
    if "role" in body and user.role == "admin":
        target.role = body["role"] if body["role"] in ("admin", "manager", "user") else target.role
    if "is_active" in body:
        target.is_active = bool(body["is_active"])
    for key in ("max_monthly_runs", "max_projects", "max_chapters_per_project"):
        if key in body:
            setattr(target, key, int(body[key]))
    if "max_active_jobs" in body and user.role == "admin":
        target.max_active_jobs = int(body["max_active_jobs"])
    if body.get("password"):
        target.password_hash = hash_password(body["password"])
    db.commit()
    _add_audit(db, user, "update_user", "user", target.id, f"更新账号 {target.username}")
    return {"user": user_to_dict(target)}


# ---------- Tasks ----------
@router.get("/admin/tasks")
def list_tasks(
    page: int = Query(1, ge=1),
    page_size: int = Query(10, ge=1, le=100),
    status: str = "",
    user_id: int = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(require_management),
):
    q = db.query(Job)
    if status:
        if status == "active":
            q = q.filter(Job.status.in_(["queued", "running"]))
        elif status == "failed":
            q = q.filter(Job.status == "failed")
        elif status == "completed":
            q = q.filter(Job.status == "completed")
    if user_id:
        q = q.filter(Job.user_id == user_id)
    total = q.count()
    jobs = q.order_by(desc(Job.id)).offset((page - 1) * page_size).limit(page_size).all()

    tasks = []
    for job in jobs:
        project = db.query(Project).filter(Project.id == job.project_id).first()
        owner = db.query(User).filter(User.id == job.user_id).first()
        tasks.append({
            "id": job.id,
            "project_id": job.project_id,
            "project_title": project.title if project else "—",
            "novel_type": project.novel_type if project else "",
            "display_name": owner.display_name if owner else "—",
            "username": owner.username if owner else "",
            "status": job.status,
            "stage": job.stage,
            "progress": job.progress,
            "current_batch": job.current_batch,
            "total_batches": job.total_batches,
            "completed_episodes": job.completed_episodes,
            "total_episodes": job.total_episodes,
        })
    total_pages = max(1, math.ceil(total / page_size))
    all_users = db.query(User).order_by(User.id.asc()).all()
    summary = {
        "active": db.query(Job).filter(Job.status.in_(["queued", "running"])).count(),
        "failed": db.query(Job).filter(Job.status == "failed").count(),
        "completed": db.query(Job).filter(Job.status == "completed").count(),
        "total": db.query(Job).count(),
    }
    return {
        "tasks": tasks,
        "pagination": {"page": page, "page_size": page_size, "total": total, "total_pages": total_pages},
        "filter_options": {"users": [{"id": u.id, "display_name": u.display_name, "username": u.username} for u in all_users]},
        "summary": summary,
    }


# ---------- Audit logs ----------
@router.get("/admin/audit-logs")
def list_audit_logs(db: Session = Depends(get_db), user: User = Depends(require_management)):
    logs = db.query(AuditLog).order_by(desc(AuditLog.id)).limit(200).all()
    result = []
    for log in logs:
        owner = db.query(User).filter(User.id == log.user_id).first() if log.user_id else None
        result.append({
            "created_at": log.created_at.isoformat() if log.created_at else None,
            "display_name": owner.display_name if owner else "系统",
            "username": owner.username if owner else "",
            "action": log.action,
            "target_type": log.target_type,
            "target_id": log.target_id,
            "summary": log.summary,
        })
    return {"logs": result}


# ---------- Settings ----------
@router.get("/admin/settings")
def get_settings(workflow_version_id: int = Query(None), db: Session = Depends(get_db), user: User = Depends(require_admin)):
    wf_id = workflow_version_id
    if wf_id is None:
        stable = db.query(WorkflowVersion).filter(WorkflowVersion.status == "stable").first()
        wf_id = stable.id if stable else None
    version = db.query(WorkflowVersion).filter(WorkflowVersion.id == wf_id).first() if wf_id else None
    all_versions = db.query(WorkflowVersion).order_by(WorkflowVersion.id.asc()).all()
    api_key = get_config_value(db, "ai_api_key")
    retry_raw = get_config_value(db, "retry_settings", "{}")
    try:
        retry = json.loads(retry_raw)
    except Exception:
        retry = {"upstream_api_retries": 1, "turn_limit_resumes": 1}
    return {
        "settings": {
            "ai_provider": get_config_value(db, "ai_provider", "deepseek"),
            "ai_model": get_config_value(db, "ai_model", "deepseek-chat"),
            "ai_base_url": get_config_value(db, "ai_base_url", "https://api.deepseek.com"),
            "batch_size": int(get_config_value(db, "batch_size", "6")),
            "retry_settings": retry,
            "whole_novel_one_shot": get_config_value(db, "whole_novel_one_shot", "true") == "true",
            "single_pass_quality": get_config_value(db, "single_pass_quality", "false") == "true",
            "one_shot_system_prompt": get_config_value(db, "one_shot_system_prompt"),
            "one_shot_default_context": get_config_value(db, "one_shot_default_context"),
            "api_key_configured": bool(api_key),
            "workflow_version": _wf_to_dict(version) if version else None,
            "workflow_versions": [_wf_to_dict(v) for v in all_versions],
            "quality_settings": (version.quality_settings if version else {}) or {},
            "quality_settings_saved_at": version.updated_at.isoformat() if version and version.quality_settings else None,
            "prompts": (version.prompts if version else {}) or {},
            "prompt_modes": (version.prompt_modes if version else {}) or {},
            "core_rule": "系统内置核心规则（本地版本）",
            "default_prompts": {},
        }
    }


@router.patch("/admin/settings")
def update_settings(body: dict, db: Session = Depends(get_db), user: User = Depends(require_admin)):
    if "ai_provider" in body:
        set_config_value(db, "ai_provider", body["ai_provider"])
    if "ai_model" in body:
        set_config_value(db, "ai_model", body["ai_model"])
    if "ai_base_url" in body:
        set_config_value(db, "ai_base_url", body["ai_base_url"])
    if body.get("ai_api_key"):
        set_config_value(db, "ai_api_key", body["ai_api_key"])
    if "batch_size" in body:
        set_config_value(db, "batch_size", str(body["batch_size"]))
    if "retry_settings" in body:
        set_config_value(db, "retry_settings", json.dumps(body["retry_settings"]))
    if "one_shot_system_prompt" in body:
        set_config_value(db, "one_shot_system_prompt", body["one_shot_system_prompt"])
    if "one_shot_default_context" in body:
        set_config_value(db, "one_shot_default_context", body["one_shot_default_context"])

    wf_id = body.get("workflow_version_id")
    if wf_id:
        version = db.query(WorkflowVersion).filter(WorkflowVersion.id == wf_id).first()
        if version and version.status == "draft":
            if "quality_settings" in body:
                version.quality_settings = body["quality_settings"]
            if "prompts" in body:
                version.prompts = body["prompts"]
            if "prompt_modes" in body:
                version.prompt_modes = body["prompt_modes"]
            db.commit()
    _add_audit(db, user, "update_settings", "system", None, "更新系统设置")
    return {"ok": True}


@router.post("/admin/settings/test-key")
def test_api_key(body: dict, db: Session = Depends(get_db), user: User = Depends(require_admin)):
    import requests as _requests
    provider = body.get("ai_provider", "openai_compatible")
    model = body.get("ai_model", "deepseek-chat")
    base_url = (body.get("ai_base_url") or "https://api.deepseek.com").rstrip("/")
    api_key = body.get("ai_api_key", "")
    if not api_key:
        raise HTTPException(status_code=400, detail="请输入 API Key")
    if not api_key.startswith("sk-"):
        raise HTTPException(status_code=400, detail="API Key 格式错误，应以 sk- 开头")
    try:
        if provider == "openai_compatible":
            url = f"{base_url}/chat/completions"
        elif provider == "anthropic":
            url = f"{base_url}/v1/messages"
        else:
            url = f"{base_url}/chat/completions"
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        payload = {"model": model, "messages": [{"role": "user", "content": "hi"}], "max_tokens": 5}
        resp = _requests.post(url, headers=headers, json=payload, timeout=15)
        if resp.status_code == 200:
            return {"ok": True, "message": "✓ API Key 有效，连接成功"}
        else:
            try:
                err = resp.json()
                msg = err.get("error", {}).get("message", str(err))
            except Exception:
                msg = resp.text[:200]
            raise HTTPException(status_code=resp.status_code, detail=f"API 返回 {resp.status_code}: {msg}")
    except _requests.exceptions.ConnectionError:
        raise HTTPException(status_code=502, detail="无法连接到 API 服务器，请检查接口地址")
    except _requests.exceptions.Timeout:
        raise HTTPException(status_code=504, detail="API 服务器响应超时")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"测试失败: {str(e)}")


# ---------- Workflow versions admin ----------
@router.post("/admin/workflow-versions")
def create_workflow_version(body: dict, db: Session = Depends(get_db), user: User = Depends(require_admin)):
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="名称不能为空")
    clone_from = body.get("clone_from")
    use_defaults = body.get("use_system_defaults", False)
    prompts = dict(DEFAULT_PROMPTS)
    quality = dict(DEFAULT_QUALITY)
    modes = dict(DEFAULT_PROMPT_MODES)
    if clone_from:
        src = db.query(WorkflowVersion).filter(WorkflowVersion.id == clone_from).first()
        if src:
            prompts = dict(src.prompts or {})
            quality = dict(src.quality_settings or {})
            modes = dict(src.prompt_modes or {})
    version = WorkflowVersion(name=name, status="draft", prompts=prompts, quality_settings=quality, prompt_modes=modes)
    db.add(version)
    db.commit()
    db.refresh(version)
    return {"workflow_version": _wf_to_dict(version)}


@router.post("/admin/workflow-versions/{version_id}/restore-default")
def restore_workflow_default(version_id: int, db: Session = Depends(get_db), user: User = Depends(require_admin)):
    version = db.query(WorkflowVersion).filter(WorkflowVersion.id == version_id).first()
    if not version:
        raise HTTPException(status_code=404, detail="版本不存在")
    if version.status != "draft":
        raise HTTPException(status_code=400, detail="仅试验版可恢复默认")
    version.prompts = dict(DEFAULT_PROMPTS)
    version.quality_settings = dict(DEFAULT_QUALITY)
    version.prompt_modes = dict(DEFAULT_PROMPT_MODES)
    db.commit()
    return {"ok": True}


@router.delete("/admin/workflow-versions/{version_id}")
def delete_workflow_version(version_id: int, db: Session = Depends(get_db), user: User = Depends(require_admin)):
    version = db.query(WorkflowVersion).filter(WorkflowVersion.id == version_id).first()
    if not version:
        raise HTTPException(status_code=404, detail="版本不存在")
    if version.status == "stable":
        raise HTTPException(status_code=400, detail="稳定版不能删除")
    preserved = db.query(Project).filter(Project.workflow_version_id == version_id).count()
    db.delete(version)
    db.commit()
    return {"ok": True, "preserved_project_count": preserved}


@router.post("/admin/workflow-versions/{version_id}/publish")
def publish_workflow_version(version_id: int, db: Session = Depends(get_db), user: User = Depends(require_admin)):
    version = db.query(WorkflowVersion).filter(WorkflowVersion.id == version_id).first()
    if not version:
        raise HTTPException(status_code=404, detail="版本不存在")
    # archive old stable
    db.query(WorkflowVersion).filter(WorkflowVersion.status == "stable").update({"status": "archived"})
    version.status = "stable"
    db.commit()
    db.refresh(version)
    _add_audit(db, user, "publish_workflow", "workflow_version", version.id, f"发布 {version.name}")
    return {"workflow_version": _wf_to_dict(version)}


# ---------- One-shot versions admin ----------
@router.get("/admin/one-shot-versions")
def admin_list_one_shot(db: Session = Depends(get_db), user: User = Depends(require_admin)):
    versions = db.query(OneShotVersion).order_by(OneShotVersion.id.asc()).all()
    stable = db.query(OneShotVersion).filter(OneShotVersion.status == "stable").first()
    return {
        "versions": [_os_to_dict(v, include_files=False) for v in versions],
        "stable_id": stable.id if stable else None,
    }


@router.post("/admin/one-shot-versions")
def create_one_shot_version(body: dict, db: Session = Depends(get_db), user: User = Depends(require_admin)):
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="名称不能为空")
    clone_from = body.get("clone_from")
    use_defaults = body.get("use_system_defaults", False)
    files = load_workflow_files()
    quality = dict(DEFAULT_QUALITY)
    context = "请读取 cursor 工作流和小说章节路径后完成拆解与剧本创作。"
    if clone_from:
        src = db.query(OneShotVersion).filter(OneShotVersion.id == clone_from).first()
        if src:
            files = dict(src.workflow_files or {})
            quality = dict(src.quality_settings or {})
            context = src.default_context or context
    version = OneShotVersion(
        name=name, status="draft", workflow_files=files, quality_settings=quality,
        reasoning_effort="medium", max_session_turns=80, default_context=context,
    )
    db.add(version)
    db.commit()
    db.refresh(version)
    return {"version": _os_to_dict(version)}


@router.patch("/admin/one-shot-versions/{version_id}")
def update_one_shot_version(version_id: int, body: dict, db: Session = Depends(get_db), user: User = Depends(require_admin)):
    version = db.query(OneShotVersion).filter(OneShotVersion.id == version_id).first()
    if not version:
        raise HTTPException(status_code=404, detail="方案不存在")
    if version.status != "draft":
        raise HTTPException(status_code=400, detail="仅试验版可编辑")
    if "name" in body:
        version.name = body["name"]
    if "description" in body:
        version.description = body["description"]
    if "reasoning_effort" in body:
        version.reasoning_effort = body["reasoning_effort"]
    if "max_session_turns" in body:
        version.max_session_turns = int(body["max_session_turns"])
    if "default_context" in body:
        version.default_context = body["default_context"]
    if "workflow_files" in body:
        version.workflow_files = body["workflow_files"]
    if "quality_settings" in body:
        version.quality_settings = body["quality_settings"]
    db.commit()
    db.refresh(version)
    return {"version": _os_to_dict(version)}


@router.post("/admin/one-shot-versions/{version_id}/publish")
def publish_one_shot_version(version_id: int, db: Session = Depends(get_db), user: User = Depends(require_admin)):
    version = db.query(OneShotVersion).filter(OneShotVersion.id == version_id).first()
    if not version:
        raise HTTPException(status_code=404, detail="方案不存在")
    db.query(OneShotVersion).filter(OneShotVersion.status == "stable").update({"status": "archived"})
    version.status = "stable"
    db.commit()
    db.refresh(version)
    _add_audit(db, user, "publish_one_shot", "one_shot_version", version.id, f"发布 {version.name}")
    return {"version": _os_to_dict(version)}


@router.delete("/admin/one-shot-versions/{version_id}")
def delete_one_shot_version(version_id: int, db: Session = Depends(get_db), user: User = Depends(require_admin)):
    version = db.query(OneShotVersion).filter(OneShotVersion.id == version_id).first()
    if not version:
        raise HTTPException(status_code=404, detail="方案不存在")
    if version.status == "stable":
        raise HTTPException(status_code=400, detail="稳定版不能删除")
    preserved = db.query(Project).filter(Project.one_shot_version_id == version_id).count()
    db.delete(version)
    db.commit()
    return {"ok": True, "preserved_project_count": preserved}

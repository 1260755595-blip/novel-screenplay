"""System, workflow-version and one-shot-version routes."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from core.database import get_db
from core.models import User, WorkflowVersion, OneShotVersion
from core.auth import get_current_user, require_admin
from core.seed import get_config_value

router = APIRouter()


def _wf_to_dict(v: WorkflowVersion) -> dict:
    return {
        "id": v.id,
        "name": v.name,
        "status": v.status,
        "prompts": v.prompts or {},
        "quality_settings": v.quality_settings or {},
        "prompt_modes": v.prompt_modes or {},
    }


def _os_to_dict(v: OneShotVersion, include_files: bool = True) -> dict:
    return {
        "id": v.id,
        "name": v.name,
        "description": v.description or "",
        "status": v.status,
        "workflow_files": v.workflow_files if include_files else {},
        "quality_settings": v.quality_settings or {},
        "reasoning_effort": v.reasoning_effort,
        "max_session_turns": v.max_session_turns,
        "default_context": v.default_context or "",
    }


@router.get("/system")
def system(db: Session = Depends(get_db)):
    needs_setup = db.query(User).count() == 0
    stable_wf = db.query(WorkflowVersion).filter(WorkflowVersion.status == "stable").first()
    stable_os = db.query(OneShotVersion).filter(OneShotVersion.status == "stable").first()
    api_key = get_config_value(db, "ai_api_key")
    return {
        "needs_setup": needs_setup,
        "ai_configured": bool(api_key),
        "provider": get_config_value(db, "ai_provider", "deepseek"),
        "model": get_config_value(db, "ai_model", "deepseek-chat"),
        "batch_size": int(get_config_value(db, "batch_size", "6")),
        "whole_novel_one_shot": get_config_value(db, "whole_novel_one_shot", "true") == "true",
        "single_pass_quality": get_config_value(db, "single_pass_quality", "false") == "true",
        "employee_max_upload_mb": int(get_config_value(db, "employee_max_upload_mb", "2")),
        "admin_server_max_upload_mb": int(get_config_value(db, "admin_server_max_upload_mb", "80")),
        "stable_workflow": {"id": stable_wf.id, "name": stable_wf.name} if stable_wf else None,
        "stable_one_shot": {"id": stable_os.id, "name": stable_os.name} if stable_os else None,
    }


@router.get("/workflow-versions")
def list_workflow_versions(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    versions = db.query(WorkflowVersion).order_by(WorkflowVersion.id.asc()).all()
    stable = db.query(WorkflowVersion).filter(WorkflowVersion.status == "stable").first()
    return {
        "versions": [_wf_to_dict(v) for v in versions],
        "stable_id": stable.id if stable else None,
    }


@router.get("/one-shot-versions")
def list_one_shot_versions(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    versions = db.query(OneShotVersion).order_by(OneShotVersion.id.asc()).all()
    stable = db.query(OneShotVersion).filter(OneShotVersion.status == "stable").first()
    return {
        "versions": [_os_to_dict(v, include_files=False) for v in versions],
        "stable_id": stable.id if stable else None,
    }


@router.get("/one-shot-versions/{version_id}")
def get_one_shot_version(version_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    version = db.query(OneShotVersion).filter(OneShotVersion.id == version_id).first()
    if not version:
        raise HTTPException(status_code=404, detail="生成方案不存在")
    return {"version": _os_to_dict(version)}

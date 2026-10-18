"""Seeding default data: workflow versions, one-shot versions, system config."""
import json
import os
from pathlib import Path
from sqlalchemy.orm import Session

from .models import WorkflowVersion, OneShotVersion, SystemConfig, User
from .auth import hash_password

WORKFLOW_ROOT = Path(__file__).resolve().parent.parent / "workflow_files" / ".cursor"

DEFAULT_QUALITY = {
    "episodes_per_6_min": 1, "episodes_per_6_max": 1, "episodes_per_6_high_density_max": 2,
    "plot_points_min": 3, "plot_points_max": 6,
    "script_han_min": 1800, "script_han_max": 2600,
    "scene_min": 6, "scene_max": 12,
    "dialogue_lines_min": 12, "dialogue_run_max": 3,
    "adjacent_action_max": 2, "same_speaker_unmerged_max": 1, "single_dialogue_han_max": 120,
    "dialogue_ratio_min": 0.45, "dialogue_ratio_max": 0.7,
    "action_ratio_min": 0.2, "action_ratio_max": 0.4,
    "narration_ratio_min": 0.05, "narration_ratio_max": 0.15,
}

DEFAULT_PROMPTS = {
    "metadata": "识别小说基础信息：题材、时代、主角、核心冲突。",
    "breakdown": "将小说拆解为剧情节点并标注分集。",
    "breakdown_review": "审核剧情拆解的完整性与节奏。",
    "script": "将剧情节点改写为漫剧剧本。",
    "script_review": "审核剧本的质量与一致性。",
}

DEFAULT_PROMPT_MODES = {k: "append" for k in DEFAULT_PROMPTS}


def load_workflow_files() -> dict:
    """Walk the .cursor directory and return {relative_path: content}."""
    files = {}
    if not WORKFLOW_ROOT.exists():
        return files
    for path in sorted(WORKFLOW_ROOT.rglob("*")):
        if path.is_file():
            try:
                rel = path.relative_to(WORKFLOW_ROOT).as_posix()
                files[f".cursor/{rel}"] = path.read_text(encoding="utf-8")
            except Exception:
                continue
    return files


def seed(db: Session):
    """Seed default data if not present."""
    # System config defaults
    defaults = {
        "ai_provider": "deepseek",
        "ai_model": "deepseek-chat",
        "ai_base_url": "https://api.deepseek.com",
        "ai_api_key": os.environ.get("DEEPSEEK_API_KEY", ""),
        "batch_size": "6",
        "employee_max_upload_mb": "2",
        "admin_server_max_upload_mb": "80",
        "whole_novel_one_shot": "true",
        "single_pass_quality": "false",
        "retry_settings": json.dumps({"upstream_api_retries": 1, "turn_limit_resumes": 1}),
        "one_shot_system_prompt": "",
        "one_shot_default_context": "",
    }
    for key, value in defaults.items():
        if not db.query(SystemConfig).filter(SystemConfig.key == key).first():
            db.add(SystemConfig(key=key, value=value))

    # Default admin (if no users exist -> setup mode)
    if db.query(User).count() == 0:
        # no seed user -> setup flow on first run
        pass

    # Workflow versions
    if db.query(WorkflowVersion).count() == 0:
        db.add(WorkflowVersion(
            name="系统内置稳定版",
            status="stable",
            prompts=dict(DEFAULT_PROMPTS),
            quality_settings=dict(DEFAULT_QUALITY),
            prompt_modes=dict(DEFAULT_PROMPT_MODES),
        ))

    # One-shot versions
    if db.query(OneShotVersion).count() == 0:
        db.add(OneShotVersion(
            name="高质量同会话稳定版",
            description="基于内置 cursor 工作流，整书一次性生成。",
            status="stable",
            workflow_files=load_workflow_files(),
            quality_settings=dict(DEFAULT_QUALITY),
            reasoning_effort="medium",
            max_session_turns=80,
            default_context="请读取 cursor 工作流和小说章节路径后完成拆解与剧本创作。",
        ))

    db.commit()


def get_config_value(db: Session, key: str, default: str = "") -> str:
    row = db.query(SystemConfig).filter(SystemConfig.key == key).first()
    return row.value if row else default


def set_config_value(db: Session, key: str, value: str):
    row = db.query(SystemConfig).filter(SystemConfig.key == key).first()
    if row:
        row.value = value
    else:
        db.add(SystemConfig(key=key, value=value))
    db.commit()

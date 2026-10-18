"""Database models for 镜界 · 小说漫剧工作台 (local version)."""
from datetime import datetime, timezone
from sqlalchemy import (
    Column, Integer, String, Boolean, Text, DateTime, ForeignKey, JSON, Float,
)
from sqlalchemy.orm import relationship

from .database import Base


def _now():
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True)
    username = Column(String(64), unique=True, nullable=False, index=True)
    display_name = Column(String(128), default="")
    password_hash = Column(String(256), nullable=False)
    role = Column(String(16), default="user")  # admin / manager / user
    is_active = Column(Boolean, default=True)

    max_monthly_runs = Column(Integer, default=100)
    max_projects = Column(Integer, default=50)
    max_active_jobs = Column(Integer, default=3)
    max_chapters_per_project = Column(Integer, default=500)
    monthly_runs = Column(Integer, default=0)

    created_at = Column(DateTime, default=_now)

    projects = relationship("Project", back_populates="user", cascade="all, delete-orphan")
    sessions = relationship("Session", back_populates="user", cascade="all, delete-orphan")


class Session(Base):
    __tablename__ = "sessions"

    id = Column(Integer, primary_key=True)
    token = Column(String(64), unique=True, nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime, default=_now)

    user = relationship("User", back_populates="sessions")


class WorkflowVersion(Base):
    __tablename__ = "workflow_versions"

    id = Column(Integer, primary_key=True)
    name = Column(String(128), nullable=False)
    status = Column(String(16), default="draft")  # stable / draft / archived
    prompts = Column(JSON, default=dict)
    quality_settings = Column(JSON, default=dict)
    prompt_modes = Column(JSON, default=dict)
    created_at = Column(DateTime, default=_now)
    updated_at = Column(DateTime, default=_now, onupdate=_now)


class OneShotVersion(Base):
    __tablename__ = "one_shot_versions"

    id = Column(Integer, primary_key=True)
    name = Column(String(128), nullable=False)
    description = Column(Text, default="")
    status = Column(String(16), default="draft")  # stable / draft / archived
    workflow_files = Column(JSON, default=dict)
    quality_settings = Column(JSON, default=dict)
    reasoning_effort = Column(String(32), default="medium")
    max_session_turns = Column(Integer, default=80)
    default_context = Column(Text, default="")
    created_at = Column(DateTime, default=_now)
    updated_at = Column(DateTime, default=_now, onupdate=_now)


class SystemConfig(Base):
    __tablename__ = "system_config"

    key = Column(String(64), primary_key=True)
    value = Column(Text, default="")
    updated_at = Column(DateTime, default=_now, onupdate=_now)


class Project(Base):
    __tablename__ = "projects"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    title = Column(String(256), default="未命名项目")
    source_filename = Column(String(256), default="")
    novel_type = Column(String(64), default="自动识别")
    raw_content = Column(Text, default="")
    chapter_count = Column(Integer, default=0)
    target_episode_count = Column(Integer, default=0)
    batch_count = Column(Integer, default=0)
    batch_size = Column(Integer, default=6)
    split_mode = Column(String(32), default="auto")

    status = Column(String(16), default="ready")  # ready/queued/running/completed/failed/paused
    workflow_version_id = Column(Integer, ForeignKey("workflow_versions.id"), nullable=True)
    one_shot_version_id = Column(Integer, ForeignKey("one_shot_versions.id"), nullable=True)
    workflow_version_name = Column(String(128), default="")
    one_shot_version_name = Column(String(128), default="")

    # generation inputs (whole-novel one-shot)
    generation_inputs_version_id = Column(Integer, nullable=True)
    generation_inputs_workflow_files = Column(JSON, default=dict)
    generation_inputs_quality = Column(JSON, default=dict)
    generation_inputs_context = Column(Text, default="")
    generation_inputs_editable = Column(Boolean, default=True)

    current_generation_job_id = Column(Integer, nullable=True)
    selected_generation_job_id = Column(Integer, nullable=True)
    generation_count = Column(Integer, default=0)
    episode_count = Column(Integer, default=0)

    created_at = Column(DateTime, default=_now)
    updated_at = Column(DateTime, default=_now, onupdate=_now)

    user = relationship("User", back_populates="projects")
    jobs = relationship("Job", back_populates="project", cascade="all, delete-orphan")
    episodes = relationship("Episode", back_populates="project", cascade="all, delete-orphan")


class Job(Base):
    __tablename__ = "jobs"

    id = Column(Integer, primary_key=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    status = Column(String(16), default="queued")  # queued/running/completed/failed/paused
    stage = Column(String(128), default="初始化")
    progress = Column(Integer, default=0)
    current_batch = Column(Integer, default=0)
    total_batches = Column(Integer, default=1)
    completed_episodes = Column(Integer, default=0)
    total_episodes = Column(Integer, default=0)
    error = Column(Text, default="")
    events = Column(JSON, default=list)
    version_no = Column(Integer, default=1)
    breakdown = Column(Text, default="")

    created_at = Column(DateTime, default=_now)
    updated_at = Column(DateTime, default=_now, onupdate=_now)
    finished_at = Column(DateTime, nullable=True)

    project = relationship("Project", back_populates="jobs")
    episodes = relationship("Episode", back_populates="job", cascade="all, delete-orphan")


class Episode(Base):
    __tablename__ = "episodes"

    id = Column(Integer, primary_key=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=False, index=True)
    job_id = Column(Integer, ForeignKey("jobs.id"), nullable=False, index=True)
    episode_no = Column(Integer, nullable=False)
    status = Column(String(16), default="pending")  # pending/revising/failed/approved
    content = Column(Text, default="")
    review = Column(Text, default="")
    created_at = Column(DateTime, default=_now)

    project = relationship("Project", back_populates="episodes")
    job = relationship("Job", back_populates="episodes")


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    action = Column(String(64), nullable=False)
    target_type = Column(String(64), default="")
    target_id = Column(Integer, nullable=True)
    summary = Column(Text, default="")
    created_at = Column(DateTime, default=_now)

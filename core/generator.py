"""AI generation core. Real DeepSeek API + mock fallback."""
import json
import re
import threading
from datetime import datetime, timezone
from sqlalchemy.orm import Session

from core.models import Project, Job, Episode
from core.seed import get_config_value


def _now():
    return datetime.now(timezone.utc)


def _log_event(job: Job, level: str, message: str):
    job.events = (job.events or []) + [{
        "level": level,
        "message": message,
        "created_at": _now().isoformat(),
    }]


def _split_chapters(content: str) -> list:
    """Split novel content into chapters by common heading patterns."""
    if not content:
        return []
    pattern = re.compile(
        r"(?m)^\s*(?:第[一二三四五六七八九十百千万零〇两\d]+[章节回卷集部篇]\s*.*|"
        r"Chapter\s+\d+.*|"
        r"CHAPTER\s+\d+.*|"
        r"卷[一二三四五六七八九十\d]+.*)\s*$"
    )
    matches = list(pattern.finditer(content))
    if not matches:
        return [content.strip()] if content.strip() else []
    chapters = []
    for i, m in enumerate(matches):
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(content)
        chapters.append((m.group(0).strip() + "\n" + content[start:end]).strip())
    return [c for c in chapters if c.strip()]


def _build_system_prompt(workflow_files: dict) -> str:
    """Build the system prompt from cursor workflow files."""
    if not workflow_files:
        return DEFAULT_SYSTEM_PROMPT

    parts = []
    # Priority: CLAUDE.md first, then SKILL.md, then templates
    order = [".cursor/CLAUDE.md", ".cursor/skills/webtoon-skill/SKILL.md",
             ".cursor/skills/webtoon-skill/adapt-method.md",
             ".cursor/skills/webtoon-skill/output-style.md",
             ".cursor/skills/webtoon-skill/templates/plot-breakdown-template.md",
             ".cursor/skills/webtoon-skill/templates/script-template.md"]
    for key in order:
        if key in workflow_files:
            parts.append(f"===== {key} =====\n{workflow_files[key]}")
    # Include any remaining files
    for key, content in workflow_files.items():
        if key not in order and not key.endswith(".py"):
            parts.append(f"===== {key} =====\n{content}")
    return "\n\n".join(parts) if parts else DEFAULT_SYSTEM_PROMPT


DEFAULT_SYSTEM_PROMPT = """你是网文改编漫剧编剧。将小说改编为可拍漫剧剧本。

核心规则：
- 每集 700-1200 字
- ▲ 只写可见画面，禁止写心想、觉得等叙述
- 台词推进：禁止只靠连续 ▲ 讲故事
- 原著优先：剧本情节按对应章节原文推进，对白尽量用原小说台词
- 1-3 个剧情点 = 1 集
- 每集结尾必须【卡黑】

剧本格式：
第N集——第N章
N-1
地点：<地点>，<内/外>，<日/夜>
人物：<角色列表>
▲<动作/画面描写>
<角色名>（<神态>）：<台词>
N-2
...
【卡黑】
"""


def _call_deepseek(system_prompt: str, user_prompt: str, config: dict) -> str:
    """Call DeepSeek (OpenAI-compatible) chat API."""
    import requests

    base_url = config.get("base_url", "https://api.deepseek.com").rstrip("/")
    api_key = config.get("api_key", "")
    model = config.get("model", "deepseek-chat")

    if not api_key:
        raise RuntimeError("未配置 AI API Key，请在系统设置中填写")

    url = f"{base_url}/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.7,
        "max_tokens": 8192,
    }
    resp = requests.post(url, headers=headers, json=payload, timeout=300)
    if resp.status_code != 200:
        raise RuntimeError(f"API 调用失败 ({resp.status_code}): {resp.text[:500]}")
    data = resp.json()
    return data["choices"][0]["message"]["content"]


def _parse_episodes_from_response(text: str) -> list:
    """Parse AI response into a list of (episode_no, content) tuples."""
    episodes = []
    # Split by episode markers: "第N集" or "EP N" or "=== EPISODE N ==="
    blocks = re.split(r'(?:^|\n)\s*第\s*(\d+)\s*集[^\n]*\n', text)
    # blocks[0] is preamble, then alternating (number, content)
    if len(blocks) > 1:
        for i in range(1, len(blocks), 2):
            try:
                ep_no = int(blocks[i])
                content = blocks[i + 1].strip() if i + 1 < len(blocks) else ""
                if content:
                    episodes.append((ep_no, content))
            except (ValueError, IndexError):
                continue
    # Fallback: split by === markers
    if not episodes:
        parts = re.split(r'={3,}\s*EP(?:ISODE)?\s*\d+\s*={3,}', text, flags=re.IGNORECASE)
        for idx, part in enumerate(parts[1:], 1):
            if part.strip():
                episodes.append((idx, part.strip()))
    return episodes


def run_generation(db: Session, project: Project, job: Job):
    """Run the generation pipeline (real API or mock)."""
    api_key = get_config_value(db, "ai_api_key")
    use_real_api = bool(api_key)

    try:
        job.status = "running"
        job.stage = "读取小说内容"
        job.progress = 5
        _log_event(job, "info", f"开始生成：{project.title}")
        db.commit()

        chapters = _split_chapters(project.raw_content)
        project.chapter_count = len(chapters)
        job.total_batches = 1
        _log_event(job, "info", f"识别到 {len(chapters)} 个章节")
        db.commit()

        if use_real_api:
            _run_real_generation(db, project, job, chapters)
        else:
            _run_mock_generation(db, project, job, chapters)

    except Exception as exc:
        job.status = "failed"
        job.error = str(exc)
        job.stage = "生成失败"
        project.status = "failed"
        _log_event(job, "error", f"生成失败：{exc}")
        db.commit()
    finally:
        db.close()


def _run_real_generation(db: Session, project: Project, job: Job, chapters: list):
    """Real AI generation via DeepSeek API using cursor workflow rules."""
    provider = get_config_value(db, "ai_provider", "deepseek")
    model = get_config_value(db, "ai_model", "deepseek-chat")
    base_url = get_config_value(db, "ai_base_url", "https://api.deepseek.com")
    api_key = get_config_value(db, "ai_api_key")
    config = {"provider": provider, "model": model, "base_url": base_url, "api_key": api_key}

    workflow_files = project.generation_inputs_workflow_files or {}
    if not workflow_files:
        from core.models import OneShotVersion
        os_ver = db.query(OneShotVersion).filter(
            OneShotVersion.id == project.generation_inputs_version_id
        ).first()
        if os_ver:
            workflow_files = os_ver.workflow_files or {}

    system_prompt = _build_system_prompt(workflow_files)

    # Step 1: Breakdown
    job.stage = "调用 AI · 剧情拆解"
    job.progress = 15
    _log_event(job, "info", f"正在调用 {model} 进行剧情拆解...")
    db.commit()

    novel_text = "\n\n".join(chapters)
    breakdown_prompt = f"""请将以下小说拆解为剧情点，并标注分集。

小说名称：{project.title}
小说类型：{project.novel_type}
章节数：{len(chapters)}

【小说原文】
{novel_text[:30000]}

请输出：
1. 主要人物列表
2. 剧情点列表（每个剧情点一行，标注第几集）
3. 分集说明：N章→M集
"""
    try:
        breakdown_text = _call_deepseek(system_prompt, breakdown_prompt, config)
        job.breakdown = breakdown_text
        _log_event(job, "info", "剧情拆解完成")
    except Exception as e:
        _log_event(job, "warning", f"拆解失败，跳过：{e}")
        breakdown_text = ""

    # Step 2: Generate scripts
    job.stage = "调用 AI · 生成剧本"
    job.progress = 30
    db.commit()

    script_prompt = f"""请根据以下小说原文和剧情拆解，创作漫剧剧本。

小说名称：{project.title}
小说类型：{project.novel_type}

【剧情拆解】
{breakdown_text[:5000]}

【小说原文】
{novel_text[:30000]}

要求：
1. 按剧情弧线分集，每集 700-1200 字
2. 每集以"第N集"开头
3. 剧本格式遵循：场景头(地点/内外/日夜) → ▲动作描写 → 角色台词
4. ▲只写可见画面，关键信息用台词
5. 台词尽量用原著原句
6. 每集结尾【卡黑】

请直接输出所有集的剧本，每集之间用一行分隔。
"""
    _log_event(job, "info", f"正在调用 {model} 生成剧本...")
    db.commit()

    response_text = _call_deepseek(system_prompt, script_prompt, config)
    _log_event(job, "info", "AI 返回完成，正在解析剧集...")

    episodes = _parse_episodes_from_response(response_text)
    if not episodes:
        # Fallback: treat whole response as single episode
        episodes = [(1, response_text.strip())]

    job.total_episodes = len(episodes)
    for idx, (ep_no, content) in enumerate(episodes, 1):
        episode = Episode(
            project_id=project.id,
            job_id=job.id,
            episode_no=ep_no,
            status="approved",
            content=content,
            review="",
        )
        db.add(episode)
        job.completed_episodes = idx
        job.progress = 30 + int(65 * (idx / max(1, len(episodes))))
        db.commit()

    job.status = "completed"
    job.stage = "全部完成"
    job.progress = 100
    job.finished_at = _now()
    _log_event(job, "success", f"生成完成，共 {len(episodes)} 集")
    project.status = "completed"
    project.episode_count = len(episodes)
    project.current_generation_job_id = job.id
    project.selected_generation_job_id = job.id
    project.generation_count = (project.generation_count or 0) + 1
    db.commit()


def _run_mock_generation(db: Session, project: Project, job: Job, chapters: list):
    """Mock generation for local preview without API key."""
    job.total_episodes = max(1, len(chapters))

    job.stage = "剧情拆解"
    job.progress = 20
    db.commit()
    breakdown = _mock_generate_breakdown(project, chapters)
    job.breakdown = breakdown
    _log_event(job, "info", "剧情拆解完成（Mock 模式），开始生成剧本")
    db.commit()

    episode_count = max(1, len(chapters))
    for i in range(episode_count):
        ep_no = i + 1
        job.stage = f"生成第 {ep_no} 集剧本"
        chapter_text = chapters[i] if i < len(chapters) else ""
        content = _mock_generate_script(project, chapter_text, ep_no)
        episode = Episode(
            project_id=project.id,
            job_id=job.id,
            episode_no=ep_no,
            status="approved",
            content=content,
            review="",
        )
        db.add(episode)
        job.completed_episodes = ep_no
        job.progress = 20 + int(75 * (ep_no / max(1, episode_count)))
        db.commit()

    job.status = "completed"
    job.stage = "全部完成"
    job.progress = 100
    job.finished_at = _now()
    _log_event(job, "success", f"生成完成（Mock），共 {episode_count} 集")
    project.status = "completed"
    project.episode_count = episode_count
    project.current_generation_job_id = job.id
    project.selected_generation_job_id = job.id
    project.generation_count = (project.generation_count or 0) + 1
    db.commit()


def _mock_generate_breakdown(project: Project, chapters: list) -> str:
    lines = [f"《{project.title}》剧情拆解与分集标注", "=" * 40, ""]
    lines.append(f"小说类型：{project.novel_type}")
    lines.append(f"章节总数：{len(chapters)}")
    lines.append("")
    lines.append("【主要人物】")
    lines.append("- 主角：待 AI 识别")
    lines.append("- 配角：待 AI 识别")
    lines.append("")
    lines.append("【剧情节点】")
    n = max(1, min(len(chapters), 6))
    for i in range(n):
        ch_title = chapters[i].split("\n")[0][:30] if chapters[i] else f"第{i+1}章"
        lines.append(f"{i+1}. {ch_title} — 推动主线发展的关键事件")
    lines.append("")
    lines.append("【分集标注】")
    eps = max(1, n)
    for i in range(eps):
        lines.append(f"- 第 {i+1} 集：覆盖节点 {i+1}，含起承转合")
    return "\n".join(lines)


def _mock_generate_script(project: Project, chapter_text: str, episode_no: int) -> str:
    preview = chapter_text[:120].replace("\n", " ") if chapter_text else ""
    return f"""第 {episode_no} 集
{'=' * 40}

【场景一 · 开场】
（环境描写）故事从《{project.title}》的世界展开。
主角：（神色）「根据剧情，这里是第 {episode_no} 集的开场。」

【场景二 · 推进】
配角：「发生了什么？」
主角：「{preview[:40] or '关键线索逐渐浮现。'}」

【场景三 · 高潮】
（冲突升级）
主角：「我必须做出选择。」

【场景四 · 收束】
（情绪沉淀，为下一集埋下伏笔）
主角：「一切才刚刚开始。」

{'=' * 40}
（本集完）
"""


def start_generation(db: Session, project: Project) -> Job:
    """Create a job and kick off generation in a background thread."""
    version_no = (project.generation_count or 0) + 1
    job = Job(
        project_id=project.id,
        user_id=project.user_id,
        status="queued",
        stage="排队中",
        progress=0,
        version_no=version_no,
    )
    db.add(job)
    project.status = "queued"
    project.current_generation_job_id = None
    db.commit()
    db.refresh(job)
    project.current_generation_job_id = job.id
    db.commit()

    from core.database import SessionLocal
    thread_db = SessionLocal()
    thread_project = thread_db.query(Project).filter(Project.id == project.id).first()
    thread_job = thread_db.query(Job).filter(Job.id == job.id).first()
    t = threading.Thread(target=run_generation, args=(thread_db, thread_project, thread_job), daemon=True)
    t.start()
    return job

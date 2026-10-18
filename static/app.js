const state = {
  system: null,
  user: null,
  recentProjects: [],
  projects: [],
  projectTypes: [],
  projectPagination: { page: 1, page_size: 10, total: 0, total_pages: 1 },
  projectListRequestSeq: 0,
  recentProjectRequestSeq: 0,
  users: [],
  workflowVersions: [],
  stableWorkflowId: null,
  oneShotVersions: [],
  stableOneShotVersionId: null,
  generationSchemeWorkflowFiles: {},
  projectWorkflowFiles: {},
  selectedGenerationSchemeId: null,
  selectedGenerationSchemeStatus: null,
  selectedSettingsWorkflowId: null,
  selectedSettingsWorkflowStatus: null,
  tasks: [],
  taskUsers: [],
  taskSummary: { active: 0, failed: 0, completed: 0, total: 0 },
  taskPagination: { page: 1, page_size: 10, total: 0, total_pages: 1 },
  taskListRequestSeq: 0,
  taskStatusFilter: "",
  taskUserFilter: "",
  activeProject: null,
  pollTimer: null,
  pollTimers: new Set(),
  pollProjectId: null,
  projectRequestSeq: 0,
  taskTimer: null,
  view: "home",
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || data.error || "请求失败，请稍后重试");
  return data;
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add("hidden"), 3200);
}

function showError(selector, message) {
  const node = $(selector);
  node.textContent = message;
  node.classList.toggle("hidden", !message);
}

function loadWorkflowFileEditor(selectSelector, contentSelector, stateKey, files = {}) {
  const select = $(selectSelector);
  const editor = $(contentSelector);
  const normalized = Object.fromEntries(
    Object.entries(files || {}).map(([path, content]) => [String(path), String(content ?? "")]),
  );
  state[stateKey] = normalized;
  const paths = Object.keys(normalized);
  select.innerHTML = paths.map(path => `<option value="${escapeHtml(path)}">${escapeHtml(path)}</option>`).join("");
  const path = paths[0] || "";
  select.value = path;
  select.dataset.currentPath = path;
  editor.value = path ? normalized[path] : "";
}

function saveCurrentWorkflowFile(selectSelector, contentSelector, stateKey) {
  const select = $(selectSelector);
  const path = select.dataset.currentPath || select.value;
  if (path) state[stateKey][path] = $(contentSelector).value;
}

function fillQualityFields(form, prefix, values = {}) {
  QUALITY_RULE_KEYS.forEach(key => {
    const field = form.elements[`${prefix}${key}`];
    if (field && values[key] !== undefined) field.value = values[key];
  });
}

function collectQualityFields(form, prefix) {
  return Object.fromEntries(
    QUALITY_RULE_KEYS.map(key => [key, Number(form.elements[`${prefix}${key}`].value)]),
  );
}

function switchWorkflowFile(selectSelector, contentSelector, stateKey) {
  saveCurrentWorkflowFile(selectSelector, contentSelector, stateKey);
  const select = $(selectSelector);
  const path = select.value;
  select.dataset.currentPath = path;
  $(contentSelector).value = state[stateKey][path] ?? "";
}

function statusInfo(status) {
  return {
    ready: ["待开始", "ready"],
    queued: ["排队中", "queued"],
    running: ["工作中", "running"],
    completed: ["已完成", "completed"],
    failed: ["需处理", "failed"],
    paused: ["已暂停", "paused"],
  }[status] || [status, "ready"];
}

function episodeStatusInfo(status) {
  return {
    approved: [state.system?.whole_novel_one_shot ? "✓ 已生成" : "✓ 已通过", "approved"],
    revising: ["! 待返修", "revising"],
    failed: ["! 未通过", "failed"],
    pending: ["待生成", "pending"],
  }[status] || [status || "未知", "pending"];
}

function updateBatchCopy() {
  const size = state.system?.batch_size || 6;
  if (state.system?.whole_novel_one_shot) {
    const hero = $("#hero-workflow-copy");
    if (hero) hero.textContent = "上传完整小说，程序自动拆成逐章TXT；同一个Claude Code会话读取cursor工作流和章节路径后完成全部创作。";
    const stepTwo = $("#flow-step-two");
    if (stepTwo) stepTwo.innerHTML = `<b>02</b><span><strong>输入类型和路径</strong><small>AI在同会话读取本地逐章TXT</small></span>`;
    const stepThree = $("#flow-step-three");
    if (stepThree) stepThree.innerHTML = `<b>03</b><span><strong>AI完成全流程</strong><small>程序只接收并保存剧本文章</small></span>`;
    const strategy = $("#project-dialog .batch-note span");
    const strategyTitle = $("#project-dialog .batch-note b");
    if (strategyTitle) strategyTitle.textContent = "当前会话方式";
    if (strategy) strategy.innerHTML = "先让 AI 读取可编辑的 cursor (2) 工作流，再告诉 AI 小说类型和 <code>novel/</code> 拆章路径。全部拆解、返修和创作由 AI 会话自行完成。";
    return;
  }
  ["#hero-batch-size", "#flow-batch-size", "#batch-size-note"].forEach(selector => {
    const node = $(selector);
    if (node) node.textContent = size;
  });
}

function updateModelStatus() {
  const configured = state.system?.ai_configured;
  $("#model-status").className = `model-status ${configured ? "ready" : "error"}`;
  $("#model-status span").textContent = configured
    ? `${state.system.whole_novel_one_shot ? "Claude Code → DeepSeek" : (state.system.provider === "anthropic" ? "Claude" : "AI")} · ${state.system.model}`
    : "模型未配置";
}

function fmtDate(value) {
  if (!value) return "—";
  const normalized = value.includes("T") ? value : value.replace(" ", "T") + "Z";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(normalized));
}

function normalizeNovelType(value) {
  return String(value || "自动识别").trim().replace(/[\s,，、/|;；·・\-－—]+/g, "") || "自动识别";
}

function pageNumbers(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  if (current <= 4) return [1, 2, 3, 4, 5, null, total];
  if (current >= total - 3) return [1, null, total - 4, total - 3, total - 2, total - 1, total];
  return [1, null, current - 1, current, current + 1, null, total];
}

function renderPagination(selector, pagination, { onPage, onPageSize }) {
  const root = $(selector);
  if (!root) return;
  const total = Number(pagination?.total || 0);
  root.classList.toggle("hidden", total === 0);
  if (!total) {
    root.innerHTML = "";
    return;
  }
  const page = Number(pagination.page || 1);
  const totalPages = Number(pagination.total_pages || 1);
  const pageSize = Number(pagination.page_size || 10);
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(total, page * pageSize);
  let ellipsisIndex = 0;
  const numberButtons = pageNumbers(page, totalPages).map(item => {
    if (item === null) return `<span class="page-ellipsis" aria-hidden="true" data-ellipsis="${ellipsisIndex++}">…</span>`;
    return `<button type="button" class="page-button ${item === page ? "active" : ""}" data-page="${item}" ${item === page ? 'aria-current="page"' : ""}>${item}</button>`;
  }).join("");
  root.innerHTML = `
    <span class="pagination-summary">共 ${total} 条 · 当前 ${start}–${end} 条</span>
    <div class="pagination-controls">
      <button type="button" class="page-button" data-page="${page - 1}" ${page <= 1 ? "disabled" : ""}>上一页</button>
      ${numberButtons}
      <button type="button" class="page-button" data-page="${page + 1}" ${page >= totalPages ? "disabled" : ""}>下一页</button>
      <label class="page-size">每页
        <select data-page-size aria-label="每页显示数量">
          ${[10, 20, 50].map(size => `<option value="${size}" ${size === pageSize ? "selected" : ""}>${size} 条</option>`).join("")}
        </select>
      </label>
      <form class="pagination-jump">
        <span>跳至</span><input type="number" min="1" max="${totalPages}" value="${page}" aria-label="跳转页码"><span>页</span>
        <button type="submit" class="page-button">跳转</button>
      </form>
    </div>`;
  $$('[data-page]', root).forEach(button => button.addEventListener("click", () => {
    if (!button.disabled) onPage(Number(button.dataset.page));
  }));
  $("[data-page-size]", root)?.addEventListener("change", event => onPageSize(Number(event.target.value)));
  $(".pagination-jump", root)?.addEventListener("submit", event => {
    event.preventDefault();
    const value = Number(event.currentTarget.querySelector("input").value);
    if (Number.isFinite(value)) onPage(Math.max(1, Math.min(totalPages, Math.trunc(value))));
  });
}

function renderEpisodeResult(episode) {
  const [episodeLabel, episodeCls] = episodeStatusInfo(episode.status);
  return `
    <div class="result-item ${episodeCls}" data-episode="${episode.episode_no}">
      <span><b>EP</b>第 ${episode.episode_no} 集</span>
      <small>${episodeLabel}</small>
    </div>`;
}

function stopProjectPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimers.forEach(timer => clearInterval(timer));
  state.pollTimers.clear();
  state.pollTimer = null;
  state.pollProjectId = null;
}

function nextProjectRequest() {
  state.projectRequestSeq += 1;
  return state.projectRequestSeq;
}

function isCurrentProjectRequest(projectId, requestSeq) {
  return requestSeq === state.projectRequestSeq
    && state.view === "detail"
    && state.activeProject?.id === projectId;
}

function startProjectPolling(projectId, requestSeq) {
  if (!isCurrentProjectRequest(projectId, requestSeq)) return;
  stopProjectPolling();
  state.pollProjectId = projectId;
  const timer = setInterval(() => refreshActiveProject(projectId, requestSeq), 2200);
  state.pollTimer = timer;
  state.pollTimers.add(timer);
}

async function boot() {
  state.system = await api("/system");
  try {
    const { user } = await api("/me");
    state.user = user;
    showApp();
  } catch (_) {
    showAuth();
  }
}

function showAuth() {
  closeProfileMenu();
  $("#app-shell").classList.add("hidden");
  $("#auth-screen").classList.remove("hidden");
  const setup = state.system.needs_setup;
  $("#login-copy").classList.toggle("hidden", setup);
  $("#setup-copy").classList.toggle("hidden", !setup);
  $("#display-name-field").classList.toggle("hidden", !setup);
  $("#auth-submit-label").textContent = setup ? "创建并进入" : "进入工作台";
  $("#auth-form [name=password]").autocomplete = setup ? "new-password" : "current-password";
}

async function showApp() {
  $("#auth-screen").classList.add("hidden");
  $("#app-shell").classList.remove("hidden");
  const first = state.user.display_name.slice(0, 1);
  $("#avatar").textContent = first;
  $("#profile-name").textContent = state.user.display_name;
  const roleLabels = { admin: "管理员", manager: "管理层", user: "员工账号" };
  const isManagement = ["admin", "manager"].includes(state.user.role);
  $("#profile-role").textContent = roleLabels[state.user.role] || "员工账号";
  $("#admin-nav").classList.toggle("hidden", !isManagement);
  $("#tasks-nav").classList.toggle("hidden", !isManagement);
  $("#audit-nav").classList.toggle("hidden", !isManagement);
  $("#settings-nav").classList.toggle("hidden", state.user.role !== "admin");
  $("#generation-schemes-nav").classList.toggle("hidden", state.user.role !== "admin");
  $("#new-user-role-field").classList.toggle("hidden", state.user.role !== "admin");
  $("#new-user-active-job-limit-field").classList.toggle("hidden", state.user.role !== "admin");
  $("#user-form [name=max_active_jobs]").disabled = state.user.role !== "admin";
  updateUploadLimitCopy();
  await Promise.all([loadWorkflowVersions(), loadOneShotVersions()]);
  updateBatchCopy();
  renderQuota();
  updateModelStatus();
  state.view = "home";
  $$(".view").forEach(node => node.classList.toggle("hidden", node.id !== "home-view"));
  $$(".nav-item").forEach(node => node.classList.toggle("active", node.dataset.view === "home"));
  $("#page-title").textContent = "项目总览";
  $("#page-kicker").textContent = "WORKSPACE";
  await loadRecentProjects();
}

function renderQuota() {
  if (!state.user) return;
  const used = state.user.monthly_runs || 0;
  const max = state.user.max_monthly_runs || 1;
  $("#quota-text").textContent = `${used} / ${max}`;
  $("#quota-bar").style.width = `${Math.min(100, used / max * 100)}%`;
}

function updateUploadLimitCopy() {
  const node = $("#upload-limit-copy");
  if (!node || !state.system || !state.user) return;
  node.textContent = state.user.role === "admin"
    ? `支持 TXT、Markdown、DOCX · 管理员不受 ${state.system.employee_max_upload_mb || 2} MB 账号限制（服务器安全上限 ${state.system.admin_server_max_upload_mb || 80} MB）`
    : `支持 TXT、Markdown、DOCX · 单次最大 ${state.system.employee_max_upload_mb || 2} MB`;
}

async function loadWorkflowVersions() {
  const result = await api("/workflow-versions");
  state.workflowVersions = result.versions || [];
  state.stableWorkflowId = result.stable_id;
  const select = $("#project-workflow-version");
  if (select) {
    select.innerHTML = state.workflowVersions.map(version => {
      const suffix = version.status === "stable" ? "（员工稳定版）" : "（试验版）";
      return `<option value="${version.id}">${escapeHtml(version.name)} ${suffix}</option>`;
    }).join("");
    select.value = String(state.stableWorkflowId || state.workflowVersions[0]?.id || "");
    select.onchange = updateProjectWorkflowNote;
  }
  $("#project-workflow-field")?.classList.toggle(
    "hidden",
    state.system?.whole_novel_one_shot || state.user.role === "user",
  );
  updateProjectWorkflowNote();
}

async function loadOneShotVersions() {
  const result = await api("/one-shot-versions");
  state.oneShotVersions = result.versions || [];
  state.stableOneShotVersionId = result.stable_id;
  const select = $("#project-one-shot-version");
  if (select) {
    select.innerHTML = state.oneShotVersions.map(version => {
      const suffix = { stable: "员工稳定版", draft: "试验版", archived: "历史版" }[version.status] || version.status;
      return `<option value="${version.id}">${escapeHtml(version.name)}（${suffix}）</option>`;
    }).join("");
    select.value = String(state.stableOneShotVersionId || state.oneShotVersions[0]?.id || "");
  }
}

function updateProjectWorkflowNote() {
  const select = $("#project-workflow-version");
  const versionId = Number(select?.value || state.stableWorkflowId);
  const version = state.workflowVersions.find(item => item.id === versionId);
  const note = $("#project-workflow-note");
  if (note) note.textContent = version?.name || state.system?.stable_workflow?.name || "稳定版";
}

$("#auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("#auth-error", "");
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  const form = new FormData(event.currentTarget);
  const body = Object.fromEntries(form);
  try {
    const path = state.system.needs_setup ? "/auth/setup" : "/auth/login";
    const { user } = await api(path, { method: "POST", body: JSON.stringify(body) });
    state.user = user;
    state.system.needs_setup = false;
    await showApp();
  } catch (error) {
    showError("#auth-error", error.message);
  } finally {
    button.disabled = false;
  }
});

function closeProfileMenu() {
  const menu = $("#profile-menu");
  const button = $("#profile-button");
  if (!menu || !button) return;
  menu.classList.add("hidden");
  button.setAttribute("aria-expanded", "false");
}

function toggleProfileMenu() {
  const menu = $("#profile-menu");
  const button = $("#profile-button");
  const willOpen = menu.classList.contains("hidden");
  menu.classList.toggle("hidden", !willOpen);
  button.setAttribute("aria-expanded", String(willOpen));
  if (willOpen) menu.querySelector("button")?.focus();
}

function resetSignedOutWorkspace() {
  state.user = null;
  state.recentProjects = [];
  state.projects = [];
  state.projectTypes = [];
  state.projectPagination = { page: 1, page_size: 10, total: 0, total_pages: 1 };
  state.projectListRequestSeq += 1;
  state.recentProjectRequestSeq += 1;
  state.users = [];
  state.workflowVersions = [];
  state.stableWorkflowId = null;
  state.oneShotVersions = [];
  state.stableOneShotVersionId = null;
  state.selectedGenerationSchemeId = null;
  state.selectedGenerationSchemeStatus = null;
  state.selectedSettingsWorkflowId = null;
  state.selectedSettingsWorkflowStatus = null;
  state.tasks = [];
  state.taskUsers = [];
  state.taskSummary = { active: 0, failed: 0, completed: 0, total: 0 };
  state.taskPagination = { page: 1, page_size: 10, total: 0, total_pages: 1 };
  state.taskListRequestSeq += 1;
  state.taskStatusFilter = "";
  state.taskUserFilter = "";
  state.activeProject = null;
  clearInterval(state.taskTimer);
  stopProjectPolling();
  nextProjectRequest();
  $("#auth-form").reset();
  if ($("#project-search")) $("#project-search").value = "";
  if ($("#project-type-filter")) $("#project-type-filter").value = "";
  if ($("#project-status-filter")) $("#project-status-filter").value = "";
  if ($("#task-status-filter")) $("#task-status-filter").value = "";
  if ($("#task-user-filter")) $("#task-user-filter").value = "";
  showError("#auth-error", "");
  showAuth();
  setTimeout(() => $("#auth-form [name=username]")?.focus(), 0);
}

async function signOut() {
  await api("/auth/logout", { method: "POST", body: "{}" });
  resetSignedOutWorkspace();
}

$("#profile-button").addEventListener("click", event => {
  event.stopPropagation();
  toggleProfileMenu();
});

$("#profile-menu").addEventListener("click", event => event.stopPropagation());
document.addEventListener("click", closeProfileMenu);
document.addEventListener("keydown", event => {
  if (event.key === "Escape") closeProfileMenu();
});

$("[data-account-action=password]").addEventListener("click", () => {
  closeProfileMenu();
  $("#password-form").reset();
  showError("#password-error", "");
  $("#password-dialog").showModal();
  setTimeout(() => $("#password-form [name=current_password]")?.focus(), 0);
});

$("[data-account-action=switch]").addEventListener("click", async () => {
  closeProfileMenu();
  try {
    await signOut();
  } catch (error) {
    showToast(error.message);
  }
});

$("[data-account-action=logout]").addEventListener("click", () => {
  closeProfileMenu();
  showError("#logout-error", "");
  $("#logout-dialog").showModal();
});

$("#password-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  showError("#password-error", "");
  if (form.elements.new_password.value !== form.elements.confirm_password.value) {
    showError("#password-error", "两次输入的新密码不一致");
    return;
  }
  button.disabled = true;
  try {
    await api("/auth/password", {
      method: "PATCH",
      body: JSON.stringify({
        current_password: form.elements.current_password.value,
        new_password: form.elements.new_password.value,
      }),
    });
    $("#password-dialog").close();
    form.reset();
    showToast("密码已修改，其他设备已退出登录");
  } catch (error) {
    showError("#password-error", error.message);
  } finally {
    button.disabled = false;
  }
});

$("#logout-confirm-form").addEventListener("submit", async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  showError("#logout-error", "");
  try {
    await signOut();
    $("#logout-dialog").close();
  } catch (error) {
    showError("#logout-error", error.message);
  } finally {
    button.disabled = false;
  }
});

function setView(view) {
  closeProfileMenu();
  clearInterval(state.taskTimer);
  if (view !== "detail") {
    stopProjectPolling();
    nextProjectRequest();
  }
  state.view = view;
  $$(".view").forEach(node => node.classList.add("hidden"));
  $(`#${view}-view`)?.classList.remove("hidden");
  $$(".nav-item").forEach(node => node.classList.toggle("active", node.dataset.view === view));
  const title = {
    home: "项目总览", projects: "我的项目", users: "账号管理",
    tasks: "任务监控", audit: "操作日志", settings: "系统设置",
    "generation-schemes": "生成方案", detail: "项目详情"
  }[view];
  $("#page-title").textContent = title;
  $("#page-kicker").textContent = ["users", "tasks", "audit", "settings", "generation-schemes"].includes(view) ? "ADMIN CONSOLE" : "WORKSPACE";
  $(".sidebar").classList.remove("open");
  if (view === "home") loadRecentProjects();
  if (view === "projects") loadProjectPage();
  if (view === "users") loadUsers();
  if (view === "tasks") {
    loadTasks();
    state.taskTimer = setInterval(loadTasks, 5000);
  }
  if (view === "audit") loadAuditLogs();
  if (view === "settings") loadSettings();
  if (view === "generation-schemes") loadGenerationSchemes();
}

$$(".nav-item").forEach(button => button.addEventListener("click", () => setView(button.dataset.view)));
$$("[data-view-target]").forEach(button => button.addEventListener("click", () => setView(button.dataset.viewTarget)));
$("#mobile-menu").addEventListener("click", () => $(".sidebar").classList.toggle("open"));

async function loadRecentProjects() {
  const requestSeq = ++state.recentProjectRequestSeq;
  try {
    const { projects } = await api("/projects?page=1&page_size=3");
    if (requestSeq !== state.recentProjectRequestSeq) return;
    state.recentProjects = projects;
    renderRecentProjects();
  } catch (error) {
    if (requestSeq === state.recentProjectRequestSeq) showToast(error.message);
  }
}

async function loadProjectPage(page = state.projectPagination.page) {
  const requestSeq = ++state.projectListRequestSeq;
  const params = new URLSearchParams({
    page: String(page || 1),
    page_size: String(state.projectPagination.page_size || 10),
  });
  const search = $("#project-search")?.value.trim() || "";
  const novelType = $("#project-type-filter")?.value || "";
  const status = $("#project-status-filter")?.value || "";
  if (search) params.set("search", search);
  if (novelType) params.set("novel_type", novelType);
  if (status) params.set("status", status);
  try {
    const result = await api(`/projects?${params.toString()}`);
    if (requestSeq !== state.projectListRequestSeq) return;
    state.projects = result.projects;
    state.projectTypes = result.filter_options?.novel_types || [];
    state.projectPagination = result.pagination;
    refreshProjectFilters();
    renderProjectList();
  } catch (error) {
    if (requestSeq === state.projectListRequestSeq) showToast(error.message);
  }
}

function refreshProjectFilters() {
  const typeSelect = $("#project-type-filter");
  if (!typeSelect) return;
  const current = typeSelect.value;
  const types = state.projectTypes;
  typeSelect.innerHTML = `<option value="">全部类型</option>` + types.map(type => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join("");
  typeSelect.value = types.includes(current) ? current : "";
}

function chapterLabel(project) {
  const count = Number(project?.chapter_count || 0);
  return count > 0 ? `${count} 章` : "待 AI 识别章节";
}

function projectCard(project) {
  const [label, cls] = statusInfo(project.status);
  const progress = project.latest_job?.progress || (project.status === "completed" ? 100 : 0);
  return `
    <article class="project-card" data-project="${project.id}">
      <div class="card-top"><span class="file-icon">稿</span><span class="status-chip ${cls}">${label}</span></div>
      <h4>${escapeHtml(project.title)}</h4>
      <p>${escapeHtml(normalizeNovelType(project.novel_type))} · ${chapterLabel(project)} · ${state.system?.whole_novel_one_shot ? "按内容自然分集" : `${project.target_episode_count ? `目标 ${project.target_episode_count} 集 · ` : ""}${project.batch_count} 批`}</p>
      <div class="card-foot">
        <span>${project.episode_count ? `已生成 ${project.episode_count} 集` : fmtDate(project.created_at)}</span>
        <span class="progress-mini"><i style="width:${progress}%"></i></span>
      </div>
    </article>`;
}

function projectRow(project) {
  const [label, cls] = statusInfo(project.status);
  return `
    <article class="project-row" data-project="${project.id}">
      <span class="file-icon">稿</span>
      <span><h4>${escapeHtml(project.title)}</h4><p>${escapeHtml(project.source_filename)}</p></span>
      <span><h4>${escapeHtml(normalizeNovelType(project.novel_type))}</h4></span>
      <span><h4>${chapterLabel(project)} / ${state.system?.whole_novel_one_shot ? "自然分集" : (project.target_episode_count ? `目标 ${project.target_episode_count} 集` : `${project.batch_count} 批`)}</h4></span>
      <span><span class="status-chip ${cls}">${label}</span></span>
      <span>›</span>
    </article>`;
}

function bindProjectClicks(root = document) {
  $$("[data-project]", root).forEach(node => node.addEventListener("click", () => openProject(Number(node.dataset.project))));
}

function renderRecentProjects() {
  const recent = state.recentProjects;
  $("#recent-projects").innerHTML = recent.map(projectCard).join("");
  $("#recent-projects").classList.toggle("hidden", !recent.length);
  $("#recent-empty").classList.toggle("hidden", !!recent.length);
  bindProjectClicks($("#recent-projects"));
}

function renderProjectList() {
  const projects = state.projects;
  const hasFilters = Boolean(
    ($("#project-search")?.value || "").trim()
    || $("#project-type-filter")?.value
    || $("#project-status-filter")?.value
  );
  $("#project-list-head")?.classList.toggle("hidden", !projects.length);
  $("#all-projects").innerHTML = projects.map(projectRow).join("");
  $("#all-projects").classList.toggle("hidden", !projects.length);
  $("#projects-empty").classList.toggle("hidden", !!projects.length);
  $("#projects-empty h3").textContent = hasFilters ? "没有符合条件的项目" : "还没有项目";
  $("#projects-empty p").textContent = hasFilters ? "请调整搜索词或筛选条件后重试。" : "支持上传 TXT、Markdown 或 DOCX 完整小说。";
  bindProjectClicks($("#all-projects"));
  renderPagination("#project-pagination", state.projectPagination, {
    onPage: nextPage => loadProjectPage(nextPage),
    onPageSize: pageSize => {
      state.projectPagination.page_size = pageSize;
      loadProjectPage(1);
    },
  });
}

let projectSearchTimer = null;
$("#project-search").addEventListener("input", () => {
  clearTimeout(projectSearchTimer);
  projectSearchTimer = setTimeout(() => loadProjectPage(1), 280);
});
$("#project-type-filter").addEventListener("change", () => loadProjectPage(1));
$("#project-status-filter").addEventListener("change", () => loadProjectPage(1));

function openProjectDialog() {
  $("#project-form").reset();
  if ($("#project-workflow-version")) {
    $("#project-workflow-version").value = String(state.stableWorkflowId || "");
  }
  if ($("#project-one-shot-version")) {
    $("#project-one-shot-version").value = String(state.stableOneShotVersionId || "");
  }
  updateProjectWorkflowNote();
  $("#file-label").textContent = "把小说拖到这里，或点击选择";
  showError("#project-error", "");
  $("#project-dialog").showModal();
}

["#new-project-top", "#hero-new-project"].forEach(id => $(id)?.addEventListener("click", openProjectDialog));
$$("[data-close]").forEach(button => button.addEventListener("click", () => $(`#${button.dataset.close}`).close()));

const fileInput = $("#novel-file");
fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) $("#file-label").textContent = `${fileInput.files[0].name} · ${(fileInput.files[0].size / 1024 / 1024).toFixed(1)} MB`;
});
const dropZone = $("#drop-zone");
["dragenter", "dragover"].forEach(name => dropZone.addEventListener(name, event => { event.preventDefault(); dropZone.classList.add("drag"); }));
["dragleave", "drop"].forEach(name => dropZone.addEventListener(name, event => { event.preventDefault(); dropZone.classList.remove("drag"); }));
dropZone.addEventListener("drop", event => {
  if (!event.dataTransfer.files.length) return;
  const transfer = new DataTransfer();
  transfer.items.add(event.dataTransfer.files[0]);
  fileInput.files = transfer.files;
  fileInput.dispatchEvent(new Event("change"));
});

$("#project-form").addEventListener("submit", async event => {
  event.preventDefault();
  showError("#project-error", "");
  const button = $("#upload-button");
  button.disabled = true;
  button.textContent = "正在上传全文…";
  try {
    const selectedFile = fileInput.files[0];
    const employeeLimit = Number(state.system.employee_max_upload_mb || 2) * 1024 * 1024;
    if (state.user.role !== "admin" && selectedFile && selectedFile.size > employeeLimit) {
      throw new Error(`员工和管理层账号单次上传不能超过 ${state.system.employee_max_upload_mb || 2} MB`);
    }
    const form = new FormData(event.currentTarget);
    const { project } = await api("/projects", { method: "POST", body: form });
    $("#project-dialog").close();
    showToast(state.system?.whole_novel_one_shot
      ? "上传成功，开始工作流后将由同一 AI 会话识别章节"
      : `已识别 ${project.chapter_count} 章，将按小说内容自然分集`);
    await loadRecentProjects();
    await openProject(project.id);
  } catch (error) {
    showError("#project-error", error.message);
  } finally {
    button.disabled = false;
    button.textContent = "上传小说";
  }
});

async function openProject(projectId) {
  const requestSeq = nextProjectRequest();
  stopProjectPolling();
  state.activeProject = { id: projectId };
  setView("detail");
  renderProjectLoading();
  try {
    const { project } = await api(`/projects/${projectId}?include_generation_inputs=1`);
    if (requestSeq !== state.projectRequestSeq) return;
    state.activeProject = project;
    renderProjectDetail();
    if (["running", "queued"].includes(project.status)) {
      startProjectPolling(projectId, requestSeq);
    }
  } catch (error) {
    if (requestSeq !== state.projectRequestSeq) return;
    renderProjectLoadError(projectId, error.message);
    showToast(error.message);
  }
}

function renderProjectLoading() {
  $("#project-detail").innerHTML = `
    <section class="detail-loading" role="status" aria-live="polite" aria-busy="true">
      <span class="loading-ring" aria-hidden="true"></span>
      <div><h3>正在打开项目…</h3><p>正在读取剧集和执行记录，请稍候。</p></div>
    </section>`;
}

function renderProjectLoadError(projectId, message) {
  $("#project-detail").innerHTML = `
    <section class="detail-load-error" role="alert">
      <span class="file-icon">!</span>
      <div><h3>项目暂时无法打开</h3><p>${escapeHtml(message || "请求失败，请稍后重试")}</p></div>
      <button id="retry-project-load" class="secondary">重新加载</button>
    </section>`;
  $("#retry-project-load")?.addEventListener("click", () => openProject(projectId));
}

async function refreshActiveProject(projectId, requestSeq = state.projectRequestSeq) {
  if (!isCurrentProjectRequest(projectId, requestSeq)) return;
  try {
    const { project } = await api(`/projects/${projectId}?include_generation_inputs=1`);
    if (!isCurrentProjectRequest(projectId, requestSeq)) return;
    state.activeProject = project;
    renderProjectDetail();
    if (!["running", "queued"].includes(project.status)) {
      stopProjectPolling();
      await loadRecentProjects();
    }
  } catch (_) {
    if (isCurrentProjectRequest(projectId, requestSeq)) stopProjectPolling();
  }
}

function renderProjectDetail() {
  const p = state.activeProject;
  const job = p.latest_job;
  const [label, cls] = statusInfo(p.status);
  const canRun = !["running", "queued"].includes(p.status);
  const canManageProject = p.user_id === state.user.id || state.user.role === "admin";
  const oneShot = Boolean(state.system?.whole_novel_one_shot);
  const generations = p.generations || [];
  const selectedGeneration = generations.find(
    item => item.job_id === p.selected_generation_job_id,
  );
  const selectedGenerationId = selectedGeneration?.job_id || p.current_generation_job_id;
  const generationQuery = selectedGenerationId
    ? `?generation_job_id=${selectedGenerationId}`
    : "";
  const runLabel = p.status === "failed" || p.status === "paused"
    ? (oneShot ? "继续AI工作流" : "继续工作流")
    : (oneShot
      ? (p.generation_count ? "重新生成" : "让AI开始完整工作流")
      : "一键开始全部");
  const events = job?.events || [];
  const eventItems = [...events].reverse();
  const episodes = p.episodes || [];
  const hasEpisodeIssues = episodes.some(episode => episode.status !== "approved");
  $("#project-detail").innerHTML = `
    <section class="detail-head">
      <div class="detail-title">
        <span class="file-icon">稿</span>
        <div><h3>${escapeHtml(p.title)}</h3><p>${escapeHtml(normalizeNovelType(p.novel_type))} · ${chapterLabel(p)} · ${oneShot ? `Claude Code路径会话 · cursor工作流：${escapeHtml(p.one_shot_version_name || "历史项目配置")}` : `${p.target_episode_count ? `目标 ${p.target_episode_count} 集 · ` : ""}每 ${p.batch_size} 章一批 · ${escapeHtml(p.split_mode)} · 工作流：${escapeHtml(p.workflow_version_name || "稳定版")}`}</p></div>
      </div>
      <div class="detail-actions">
        <span class="status-chip ${cls}">${label}</span>
        ${p.episode_count ? `<a class="primary" href="/api/projects/${p.id}/download-word${generationQuery}">下载 Word 剧本</a>` : ""}
        ${oneShot && canManageProject && p.generation_inputs?.editable ? `<button id="edit-generation-inputs" class="secondary">修改 AI 输入</button>` : ""}
        ${!canManageProject ? `<span class="status-chip ready">只读查看</span>` : ["running", "queued"].includes(p.status)
          ? `<button id="pause-job" class="secondary">安全暂停</button>`
          : `<button id="run-project" class="primary run-button" ${canRun ? "" : "disabled"}>${runLabel} →</button>`}
        ${canManageProject && !["running", "queued"].includes(p.status) ? `<button id="delete-project" class="danger-button">删除项目</button>` : ""}
      </div>
    </section>
    ${job ? `
      <section class="job-panel">
        <div class="job-panel-top">
          <div><span class="eyebrow light">${oneShot ? "AI WORKFLOW" : "LIVE WORKFLOW"}</span><h3>${escapeHtml(job.stage)}</h3><p>${job.status === "completed" ? (oneShot ? "本次生成已完成，结果已保存" : "所有结果都已通过审核并保存") : "可离开此页面，任务会继续在服务器运行"}</p></div>
          <span class="job-percent">${job.progress}%</span>
        </div>
        <div class="job-track"><i style="width:${job.progress}%"></i></div>
        <div class="job-stats">
          <span><b>${job.current_batch || 0} / ${job.total_batches}</b><small>${oneShot ? "整书会话" : "当前批次"}</small></span>
          <span><b>${job.completed_episodes} / ${job.total_episodes || "待定"}</b><small>${oneShot ? "已保存剧集" : "通过剧集"}</small></span>
          <span><b>${p.target_episode_count || p.chapter_count || "待识别"}</b><small>${p.target_episode_count ? "目标集数" : "小说章节"}</small></span>
          <span><b>${oneShot ? "AI负责" : p.batch_size}</b><small>${oneShot ? "内容检查" : "每批章节"}</small></span>
        </div>
      </section>
      ${job.error ? `<div class="error-box"><b>任务提示：</b>${escapeHtml(job.error)}</div>` : ""}
    ` : ""}
    <section class="detail-grid">
      <div class="panel">
        <div class="panel-title"><h3>执行记录</h3><small>${events.length ? `${events.length} 条 · 最新在上` : "0 条"}</small></div>
        <div class="event-list">
          ${eventItems.length ? eventItems.map(e => `<div class="event ${e.level}"><p>${escapeHtml(e.message)}</p><small>${fmtDate(e.created_at)}</small></div>`).join("") : `<div class="empty-state"><p>点击“一键开始全部”后，这里会实时显示每一步。</p></div>`}
        </div>
      </div>
      <div class="panel">
        <div class="panel-title"><h3>${oneShot ? "分集剧本" : (hasEpisodeIssues ? "剧集结果与反馈" : "审核通过的结果")}</h3>${episodes.length && !oneShot ? `<button id="read-breakdown" class="text-button">剧情拆解</button>` : ""}</div>
        ${oneShot && generations.length ? `
          <div class="generation-toolbar">
            <label><span>生成版本</span><select id="generation-select">
              ${generations.map(version => `<option value="${version.job_id}" ${version.job_id === selectedGenerationId ? "selected" : ""}>版本 ${version.version_no} · ${version.episode_count} 集${version.is_current ? "（当前）" : ""} · ${fmtDate(version.finished_at || version.created_at)}</option>`).join("")}
            </select></label>
            ${canManageProject && selectedGeneration && !["running", "queued"].includes(p.status) ? `<button id="delete-generation" class="danger-button mini-button">删除此版本</button>` : ""}
            ${canManageProject && generations.length > 1 && !["running", "queued"].includes(p.status) ? `<button id="delete-all-generations" class="danger-button mini-button">删除全部版本</button>` : ""}
          </div>
        ` : ""}
        <div class="result-list">
          ${episodes.length ? episodes.map(renderEpisodeResult).join("") : `<div class="empty-state"><p>${oneShot ? "AI会话按路径完成工作流后，返回的剧本文章会直接出现在这里。" : "剧本通过双重审核后会出现在这里。"}</p></div>`}
        </div>
      </div>
    </section>`;

  $("#run-project")?.addEventListener("click", runActiveProject);
  $("#edit-generation-inputs")?.addEventListener("click", openGenerationInputsDialog);
  $("#pause-job")?.addEventListener("click", pauseActiveJob);
  $("#delete-project")?.addEventListener("click", deleteActiveProject);
  $("#generation-select")?.addEventListener("change", event => selectGeneration(Number(event.target.value)));
  $("#delete-generation")?.addEventListener("click", deleteSelectedGeneration);
  $("#delete-all-generations")?.addEventListener("click", deleteAllGenerations);
  $("#read-breakdown")?.addEventListener("click", readBreakdown);
  $$("[data-episode]", $("#project-detail")).forEach(node => node.addEventListener("click", () => readEpisode(Number(node.dataset.episode))));
}

async function openGenerationInputsDialog() {
  const projectId = state.activeProject?.id;
  let inputs = state.activeProject?.generation_inputs;
  if (!inputs?.editable) {
    showToast("当前状态不能修改 AI 输入");
    return;
  }
  const button = $("#edit-generation-inputs");
  if (button) {
    button.disabled = true;
    button.textContent = "正在读取…";
  }
  try {
    if (!inputs.workflow_files) {
      const result = await api(`/projects/${projectId}/generation-inputs`);
      if (state.activeProject?.id !== projectId) return;
      inputs = result.generation_inputs;
      state.activeProject.generation_inputs = inputs;
    }
    const form = $("#generation-inputs-form");
    const versionSelect = form.elements.version_id;
    versionSelect.innerHTML = state.oneShotVersions.map(version => {
      const suffix = version.status === "stable" ? "稳定版" : "试验版";
      return `<option value="${version.id}">${escapeHtml(version.name)}（${suffix}）</option>`;
    }).join("");
    versionSelect.value = String(inputs.version_id || state.stableOneShotVersionId || "");
    loadWorkflowFileEditor(
      "#project-workflow-file",
      "#project-workflow-content",
      "projectWorkflowFiles",
      inputs.workflow_files,
    );
    fillQualityFields(form, "project_quality_", inputs.quality_settings);
    form.elements.context.value = inputs.context || "";
    showError("#generation-inputs-error", "");
    $("#generation-inputs-dialog").showModal();
  } catch (error) {
    showToast(error.message);
  } finally {
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = "修改 AI 输入";
    }
  }
}

$("#generation-inputs-version").addEventListener("change", async event => {
  try {
    const { version } = await api(`/one-shot-versions/${Number(event.target.value)}`);
    const form = $("#generation-inputs-form");
    loadWorkflowFileEditor(
      "#project-workflow-file",
      "#project-workflow-content",
      "projectWorkflowFiles",
      version.workflow_files,
    );
    fillQualityFields(form, "project_quality_", version.quality_settings);
    form.elements.context.value = version.default_context || "";
    showToast(`已载入“${version.name}”，点击保存后才会绑定到项目`);
  } catch (error) {
    showError("#generation-inputs-error", error.message);
  }
});

$("#project-workflow-file").addEventListener("change", () => {
  switchWorkflowFile(
    "#project-workflow-file",
    "#project-workflow-content",
    "projectWorkflowFiles",
  );
});

$("#generation-inputs-form").addEventListener("submit", async event => {
  event.preventDefault();
  showError("#generation-inputs-error", "");
  const form = event.currentTarget;
  const button = $("#save-generation-inputs");
  button.disabled = true;
  button.textContent = "正在保存…";
  try {
    saveCurrentWorkflowFile(
      "#project-workflow-file",
      "#project-workflow-content",
      "projectWorkflowFiles",
    );
    const { generation_inputs: inputs } = await api(
      `/projects/${state.activeProject.id}/generation-inputs`,
      {
        method: "PATCH",
        body: JSON.stringify({
          version_id: Number(form.elements.version_id.value),
          workflow_files: state.projectWorkflowFiles,
          quality_settings: collectQualityFields(form, "project_quality_"),
          context: form.elements.context.value,
        }),
      },
    );
    state.activeProject.generation_inputs = inputs;
    $("#generation-inputs-dialog").close();
    showToast("cursor (2) 工作流、质量合同和项目上下文已冻结");
    renderProjectDetail();
  } catch (error) {
    showError("#generation-inputs-error", error.message);
  } finally {
    button.disabled = false;
    button.textContent = "保存 AI 输入";
  }
});

async function runActiveProject() {
  if (!state.system.ai_configured) {
    showToast("未配置 AI Key，将使用 Mock 模式生成示例剧本");
  }
  const projectId = state.activeProject.id;
  const isRegeneration = state.activeProject.status === "completed"
    && Boolean(state.activeProject.generation_count);
  if (isRegeneration && !confirm("确定重新生成？当前版本会保留在版本记录中，之后可以切换查看、下载或删除旧版本。")) {
    return;
  }
  const requestSeq = state.projectRequestSeq;
  const button = $("#run-project");
  button.disabled = true;
  button.textContent = "正在启动…";
  try {
    const result = await api(`/projects/${projectId}/run`, { method: "POST", body: "{}" });
    if (result.user) {
      state.user = result.user;
      renderQuota();
    }
    if (!isCurrentProjectRequest(projectId, requestSeq)) return;
    showToast(state.system?.whole_novel_one_shot ? "已发起整部小说同会话连续生成，可以关闭页面" : "工作流已启动，可以关闭页面");
    await refreshActiveProject(projectId, requestSeq);
    startProjectPolling(projectId, requestSeq);
  } catch (error) {
    showToast(error.message);
    button.disabled = false;
    renderProjectDetail();
  }
}

async function selectGeneration(jobId) {
  const projectId = state.activeProject?.id;
  if (!projectId || !jobId) return;
  try {
    const { project } = await api(`/projects/${projectId}?generation_job_id=${jobId}&include_generation_inputs=0`);
    if (state.activeProject?.id !== projectId) return;
    state.activeProject = project;
    renderProjectDetail();
  } catch (error) {
    showToast(error.message);
  }
}

async function deleteSelectedGeneration() {
  const project = state.activeProject;
  const jobId = project?.selected_generation_job_id;
  const selected = (project?.generations || []).find(item => item.job_id === jobId);
  if (!project || !selected) return;
  const versions = project.generations || [];
  const warning = selected.is_current
    ? (versions.length === 1
      ? `版本 ${selected.version_no} 是最后一个生成版本。删除后项目将没有成品，但会保留小说原文和项目设置，之后仍可重新生成。确定删除？`
      : `版本 ${selected.version_no} 是当前版本。删除后上一版会自动成为当前版本。确定删除？`)
    : `确定删除生成版本 ${selected.version_no}？该版本的剧本、日志和下载文件会永久删除。`;
  if (!confirm(warning)) return;
  try {
    await api(`/projects/${project.id}/generations/${jobId}`, {
      method: "DELETE",
      body: "{}",
    });
    showToast(`生成版本 ${selected.version_no} 已删除`);
    await refreshActiveProject(project.id);
  } catch (error) {
    showToast(error.message);
  }
}

async function deleteAllGenerations() {
  const project = state.activeProject;
  const count = project?.generations?.length || 0;
  if (!project || !count) return;
  if (!confirm(`确定删除全部 ${count} 个生成版本？所有剧本、生成日志和下载文件都会永久删除；小说原文和项目设置仍会保留。`)) return;
  try {
    await api(`/projects/${project.id}/generations`, {
      method: "DELETE",
      body: "{}",
    });
    showToast(`已删除全部 ${count} 个生成版本`);
    await refreshActiveProject(project.id);
  } catch (error) {
    showToast(error.message);
  }
}

async function pauseActiveJob() {
  const job = state.activeProject.latest_job;
  try {
    const result = await api(`/jobs/${job.id}/pause`, { method: "POST", body: "{}" });
    showToast(result.message);
  } catch (error) {
    showToast(error.message);
  }
}

async function deleteActiveProject() {
  const project = state.activeProject;
  if (!project) return;
  if (!confirm(`确定删除《${project.title}》？项目、章节、任务记录和已生成剧本都会删除。`)) return;
  if (!confirm("二次确认：删除后不能在系统内恢复。确认继续删除？")) return;
  try {
    await api(`/projects/${project.id}`, { method: "DELETE", body: "{}" });
    showToast("项目已删除");
    stopProjectPolling();
    state.activeProject = null;
    await loadRecentProjects();
    setView("projects");
  } catch (error) {
    showToast(error.message);
  }
}

async function readEpisode(number) {
  try {
    const generationId = state.activeProject.selected_generation_job_id;
    const query = generationId ? `?generation_job_id=${generationId}` : "";
    const { episode } = await api(`/projects/${state.activeProject.id}/episodes/${number}${query}`);
    const [episodeLabel] = episodeStatusInfo(episode.status);
    $("#reader-kicker").textContent = "SCRIPT PREVIEW";
    $("#reader-title").textContent = `第 ${number} 集 · ${episodeLabel.replace("✓ ", "").replace("! ", "")}`;
    $("#reader-content").textContent = episode.status === "approved"
      ? episode.content
      : `${episode.content}\n\n===== 审核反馈 / 返修依据 =====\n${episode.review || "暂无审核反馈"}`;
    $("#reader-dialog").showModal();
  } catch (error) { showToast(error.message); }
}

async function readBreakdown() {
  try {
    const generationId = state.activeProject.selected_generation_job_id;
    const query = generationId ? `?generation_job_id=${generationId}` : "";
    const { content } = await api(`/projects/${state.activeProject.id}/breakdown${query}`);
    $("#reader-kicker").textContent = "PLOT BREAKDOWN";
    $("#reader-title").textContent = "剧情拆解与分集标注";
    $("#reader-content").textContent = content;
    $("#reader-dialog").showModal();
  } catch (error) { showToast(error.message); }
}

$("#back-projects").addEventListener("click", () => { stopProjectPolling(); setView("projects"); });

async function loadUsers() {
  if (!["admin", "manager"].includes(state.user.role)) return;
  try {
    const { users } = await api("/admin/users");
    state.users = users;
    $("#users-table").innerHTML = users.map(user => {
      const roleLabels = { admin: "管理员", manager: "管理层", user: "员工" };
      const canEdit = state.user.role === "admin" || user.role === "user";
      const displayName = user.display_name || user.username || "未命名";
      const initial = displayName.trim().slice(0, 1) || "员";
      return `
      <tr>
        <td>
          <div class="user-cell">
            <span class="user-avatar">${escapeHtml(initial)}</span>
            <span class="user-meta"><b>${escapeHtml(displayName)}</b><small>@${escapeHtml(user.username || "")}</small></span>
          </div>
        </td>
        <td>${roleLabels[user.role] || "员工"}</td>
        <td>${user.monthly_runs} / ${user.max_monthly_runs}</td>
        <td>${user.max_projects}</td><td>${user.max_active_jobs} 个</td><td>${user.max_chapters_per_project} 章</td>
        <td><button class="toggle-user ${user.is_active ? "on" : "off"}" data-user="${user.id}" data-active="${user.is_active}" ${canEdit ? "" : "disabled"}>${user.is_active ? "已启用" : "已停用"}</button></td>
        <td><button class="secondary mini-button" data-edit-user="${user.id}" ${canEdit ? "" : "disabled"}>编辑</button></td>
      </tr>`;
    }).join("");
    $$("[data-user]").forEach(button => button.addEventListener("click", () => toggleUser(button)));
    $$("[data-edit-user]").forEach(button => button.addEventListener("click", () => openUserEdit(Number(button.dataset.editUser))));
  } catch (error) { showToast(error.message); }
}

async function toggleUser(button) {
  const next = button.dataset.active !== "true";
  try {
    await api(`/admin/users/${button.dataset.user}`, { method: "PATCH", body: JSON.stringify({ is_active: next }) });
    showToast(next ? "账号已启用" : "账号已停用");
    loadUsers();
  } catch (error) { showToast(error.message); }
}

function openUserEdit(userId) {
  const user = state.users.find(item => item.id === userId);
  if (!user) return;
  if (state.user.role === "manager" && user.role !== "user") return;
  const form = $("#user-edit-form");
  form.reset();
  showError("#user-edit-error", "");
  $("#user-edit-title").textContent = `编辑账号：${user.display_name}`;
  form.elements.user_id.value = user.id;
  form.elements.display_name.value = user.display_name;
  form.elements.role.value = user.role;
  form.elements.role.disabled = state.user.role !== "admin";
  form.elements.max_monthly_runs.value = user.max_monthly_runs;
  form.elements.max_projects.value = user.max_projects;
  form.elements.max_active_jobs.value = user.max_active_jobs;
  form.elements.max_active_jobs.disabled = state.user.role !== "admin";
  $("#user-edit-active-job-limit-field").classList.toggle("hidden", state.user.role !== "admin");
  form.elements.max_chapters_per_project.value = user.max_chapters_per_project;
  form.elements.is_active.checked = user.is_active;
  $("#user-edit-dialog").showModal();
}

$("#user-edit-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const body = {
    display_name: form.elements.display_name.value,
    role: form.elements.role.value,
    max_monthly_runs: Number(form.elements.max_monthly_runs.value),
    max_projects: Number(form.elements.max_projects.value),
    max_chapters_per_project: Number(form.elements.max_chapters_per_project.value),
    is_active: form.elements.is_active.checked,
  };
  if (state.user.role === "admin") {
    body.max_active_jobs = Number(form.elements.max_active_jobs.value);
  }
  if (form.elements.password.value) body.password = form.elements.password.value;
  try {
    await api(`/admin/users/${form.elements.user_id.value}`, { method: "PATCH", body: JSON.stringify(body) });
    $("#user-edit-dialog").close();
    showToast("账号设置已保存");
    loadUsers();
  } catch (error) {
    showError("#user-edit-error", error.message);
  }
});

$("#new-user-button").addEventListener("click", () => {
  $("#user-form").reset();
  $("#user-form").elements.role.value = "user";
  showError("#user-error", "");
  $("#user-dialog").showModal();
});
$("#user-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const body = Object.fromEntries(form);
  ["max_monthly_runs", "max_projects", "max_chapters_per_project", "max_active_jobs"].forEach(key => {
    if (key in body) body[key] = Number(body[key]);
  });
  try {
    await api("/admin/users", { method: "POST", body: JSON.stringify(body) });
    $("#user-dialog").close();
    showToast("员工账号已创建");
    loadUsers();
  } catch (error) { showError("#user-error", error.message); }
});

async function loadTasks(page = state.taskPagination.page) {
  if (!["admin", "manager"].includes(state.user.role)) return;
  const requestSeq = ++state.taskListRequestSeq;
  const params = new URLSearchParams({
    page: String(page || 1),
    page_size: String(state.taskPagination.page_size || 10),
  });
  if (state.taskStatusFilter) params.set("status", state.taskStatusFilter);
  if (state.taskUserFilter) params.set("user_id", state.taskUserFilter);
  try {
    const result = await api(`/admin/tasks?${params.toString()}`);
    if (requestSeq !== state.taskListRequestSeq) return;
    state.tasks = result.tasks;
    state.taskUsers = result.filter_options?.users || [];
    state.taskSummary = result.summary || { active: 0, failed: 0, completed: 0, total: 0 };
    state.taskPagination = result.pagination;
    refreshTaskUserFilter();
    renderTasks();
  } catch (error) {
    if (requestSeq === state.taskListRequestSeq) {
      showToast(error.message);
      clearInterval(state.taskTimer);
    }
  }
}

function refreshTaskUserFilter() {
  const select = $("#task-user-filter");
  if (!select) return;
  const current = state.taskUserFilter;
  const users = state.taskUsers;
  select.innerHTML = `<option value="">全部员工</option>` + users.map(user => (
    `<option value="${user.id}">${escapeHtml(user.display_name)} @${escapeHtml(user.username)}</option>`
  )).join("");
  select.value = users.some(user => String(user.id) === String(current)) ? current : "";
  state.taskUserFilter = select.value;
}

function renderTasks() {
  const tasks = state.tasks;
  const counts = state.taskSummary;
  $("#task-summary").innerHTML = `
    <button class="task-stat ${state.taskStatusFilter === "active" ? "active" : ""}" data-task-filter="active"><small>正在运行</small><b>${counts.active}</b></button>
    <button class="task-stat ${state.taskStatusFilter === "failed" ? "active" : ""}" data-task-filter="failed"><small>需要处理</small><b>${counts.failed}</b></button>
    <button class="task-stat ${state.taskStatusFilter === "completed" ? "active" : ""}" data-task-filter="completed"><small>已经完成</small><b>${counts.completed}</b></button>
    <button class="task-stat ${!state.taskStatusFilter ? "active" : ""}" data-task-filter=""><small>全部任务</small><b>${counts.total}</b></button>`;
  $$("[data-task-filter]").forEach(button => button.addEventListener("click", () => {
    state.taskStatusFilter = button.dataset.taskFilter;
    $("#task-status-filter").value = state.taskStatusFilter;
    loadTasks(1);
  }));

  $("#tasks-table").innerHTML = tasks.length ? tasks.map(task => {
    const [label, cls] = statusInfo(task.status);
    return `<tr>
      <td><b class="task-project" data-task-project="${task.project_id}">${escapeHtml(task.project_title)}</b><br><small>${escapeHtml(normalizeNovelType(task.novel_type))}</small></td>
      <td>${escapeHtml(task.display_name)}<br><small>@${escapeHtml(task.username)}</small></td>
      <td>${escapeHtml(task.stage)}</td>
      <td>${task.current_batch} / ${task.total_batches}</td>
      <td>${task.completed_episodes} / ${task.total_episodes || "待定"}</td>
      <td><span class="table-progress"><i style="--progress:${task.progress}%"></i><small>${task.progress}%</small></span></td>
      <td><span class="status-chip ${cls}">${label}</span></td>
    </tr>`;
  }).join("") : `<tr><td colspan="7">没有符合筛选条件的任务</td></tr>`;
  $$("[data-task-project]").forEach(node => node.addEventListener("click", () => openProject(Number(node.dataset.taskProject))));
  renderPagination("#task-pagination", state.taskPagination, {
    onPage: nextPage => loadTasks(nextPage),
    onPageSize: pageSize => {
      state.taskPagination.page_size = pageSize;
      loadTasks(1);
    },
  });
}

$("#task-status-filter").addEventListener("change", event => {
  state.taskStatusFilter = event.target.value;
  loadTasks(1);
});
$("#task-user-filter").addEventListener("change", event => {
  state.taskUserFilter = event.target.value;
  loadTasks(1);
});

$("#refresh-tasks").addEventListener("click", loadTasks);

async function loadAuditLogs() {
  if (!["admin", "manager"].includes(state.user.role)) return;
  try {
    const { logs } = await api("/admin/audit-logs");
    $("#audit-table").innerHTML = logs.length ? logs.map(log => `
      <tr>
        <td>${fmtDate(log.created_at)}</td>
        <td>${escapeHtml(log.display_name || "系统")}<br><small>${log.username ? `@${escapeHtml(log.username)}` : "—"}</small></td>
        <td>${escapeHtml(log.action)}</td>
        <td>${escapeHtml(log.target_type)}${log.target_id ? ` #${log.target_id}` : ""}</td>
        <td>${escapeHtml(log.summary)}</td>
      </tr>`).join("") : `<tr><td colspan="5">暂无操作日志</td></tr>`;
  } catch (error) {
    showToast(error.message);
  }
}

$("#refresh-audit").addEventListener("click", loadAuditLogs);

async function loadSettings(workflowVersionId = state.selectedSettingsWorkflowId) {
  if (state.user.role !== "admin") return;
  try {
    const query = workflowVersionId ? `?workflow_version_id=${workflowVersionId}` : "";
    const { settings } = await api(`/admin/settings${query}`);
    const form = $("#settings-form");
    const version = settings.workflow_version;
    const oneShot = Boolean(settings.whole_novel_one_shot);
    // 整书提示词和质量参数已独立到“生成方案”页面；此处只保留模型连接。
    $("#one-shot-settings-card")?.classList.add("hidden");
    $$(".legacy-workflow-settings").forEach(node => node.classList.toggle("hidden", oneShot));
    if ($("#settings-intro-copy")) {
      $("#settings-intro-copy").textContent = oneShot
        ? "这里只管理 DeepSeek 接口、模型和密钥；完整提示词与质量参数请到“生成方案”页面维护。"
        : "管理模型、分批规则、数值质量标准和工作流版本。";
    }
    state.selectedSettingsWorkflowId = version?.id || null;
    state.selectedSettingsWorkflowStatus = version?.status || null;
    const versionSelect = $("#workflow-version-select");
    versionSelect.innerHTML = (settings.workflow_versions || []).map(item => {
      const suffix = { stable: "稳定版", draft: "试验版", archived: "历史版" }[item.status] || item.status;
      return `<option value="${item.id}">${escapeHtml(item.name)}（${suffix}）</option>`;
    }).join("");
    versionSelect.value = String(version?.id || "");
    const statusLabels = { stable: "员工稳定版 · 已锁定", draft: "试验版 · 可编辑", archived: "历史版 · 已锁定" };
    const statusNode = $("#workflow-version-status");
    statusNode.textContent = statusLabels[version?.status] || "未知状态";
    statusNode.className = `status-chip ${version?.status === "stable" ? "completed" : version?.status === "draft" ? "queued" : "ready"}`;
    const editable = version?.status === "draft";
    const singlePass = Boolean(settings.single_pass_quality);
    $(".prompt-card").classList.toggle("prompt-locked", !editable);
    PROMPT_STAGES.forEach(stage => {
      const runtimeEditable = editable && (!singlePass || stage === "metadata");
      form.elements[`prompt_${stage}`].disabled = !runtimeEditable;
      form.elements[`mode_${stage}`].disabled = !runtimeEditable;
    });
    QUALITY_RULE_KEYS.forEach(key => {
      form.elements[`quality_${key}`].disabled = !editable;
    });
    $("#restore-workflow-version").disabled = !editable;
    $("#delete-workflow-version").disabled = !version || version.status === "stable";
    $("#delete-workflow-version").title = version?.status === "stable"
      ? "当前员工稳定版不能删除，请先发布其他版本"
      : "删除后无法恢复；已有项目继续使用创建时保存的工作流快照";
    $("#publish-workflow-version").disabled = version?.status === "stable";
    $("#workflow-version-help").textContent = singlePass
      ? "当前生产只使用精简三组合同；可编辑试验版仅允许调整数值和类型识别。旧长提示保留作历史记录，不进入调用。"
      : (editable
        ? "当前是可编辑试验版。提示词与数值质量标准会一起保存；建议先小样本测试，再发布为员工稳定版。"
        : "当前版本的提示词与数值质量标准均已锁定。请复制为试验版后修改；已有项目始终使用创建时快照。");
    form.elements.ai_provider.value = settings.ai_provider || "anthropic";
    form.elements.ai_model.value = settings.ai_model || "";
    form.elements.ai_base_url.value = settings.ai_base_url || "";
    form.elements.ai_api_key.value = "";
    form.elements.ai_api_key.placeholder = settings.api_key_configured ? "✓ 已保存密钥，留空则不修改" : "请输入 API Key";
    form.elements.batch_size.value = settings.batch_size || 6;
    const retrySettings = settings.retry_settings || {};
    form.elements.upstream_api_retries.value = retrySettings.upstream_api_retries ?? 1;
    form.elements.turn_limit_resumes.value = retrySettings.turn_limit_resumes ?? 1;
    const retryStatus = $("#retry-settings-status");
    if (retryStatus) {
      retryStatus.textContent = `API ${form.elements.upstream_api_retries.value} 次 · 回合续跑 ${form.elements.turn_limit_resumes.value} 次`;
      retryStatus.style.color = "var(--green)";
    }
    form.elements.one_shot_system_prompt.value = settings.one_shot_system_prompt || "";
    form.elements.one_shot_default_context.value = settings.one_shot_default_context || "";
    if ($("#one-shot-builtin-prompt")) {
      $("#one-shot-builtin-prompt").textContent = settings.one_shot_builtin_prompt || "（未提供）";
    }
    Object.entries(settings.quality_settings || {}).forEach(([key, value]) => {
      const field = form.elements[`quality_${key}`];
      if (field) field.value = value;
    });
    const qualityStatus = $("#quality-save-status");
    if (qualityStatus) {
      qualityStatus.textContent = settings.quality_settings_saved_at
        ? `✓ ${version?.name || "当前版本"} · ${fmtDate(settings.quality_settings_saved_at)}`
        : `${version?.name || "当前版本"} · 系统默认值`;
      qualityStatus.style.color = settings.quality_settings_saved_at ? "var(--green)" : "var(--muted)";
    }
    Object.entries(settings.prompts || {}).forEach(([stage, value]) => {
      const field = form.elements[`prompt_${stage}`];
      if (field) field.value = value || "";
    });
    // 内置默认规则只读展示
    const core = $("#core-rule-view");
    if (core) core.textContent = settings.core_rule || "（未提供）";
    Object.entries(settings.default_prompts || {}).forEach(([stage, text]) => {
      const view = $(`[data-default-view="${stage}"]`);
      if (view) view.textContent = text || "（该步骤无独立默认规则文件）";
    });
    // 覆盖/叠加模式
    Object.entries(settings.prompt_modes || {}).forEach(([stage, mode]) => {
      applyPromptMode(stage, mode === "override");
    });
    $("#key-status").textContent = settings.api_key_configured ? "✓ 密钥已配置" : "密钥未配置";
    $("#key-status").style.color = settings.api_key_configured ? "var(--green)" : "var(--accent)";
  } catch (error) { showToast(error.message); }
}

$("#workflow-version-select").addEventListener("change", event => {
  loadSettings(Number(event.target.value));
});

function askWorkflowVersionName(defaultName) {
  const value = window.prompt("请输入新试验版名称", defaultName);
  return value === null ? "" : value.trim();
}

$("#clone-workflow-version").addEventListener("click", async () => {
  const current = $("#workflow-version-select").selectedOptions[0]?.textContent || "当前版本";
  const name = askWorkflowVersionName(`${current.replace(/（.*?）/g, "")}优化试验版`);
  if (!name) return;
  try {
    const { workflow_version: version } = await api("/admin/workflow-versions", {
      method: "POST",
      body: JSON.stringify({ name, clone_from: state.selectedSettingsWorkflowId }),
    });
    showToast("试验版已创建，提示词与质量数值已一并复制");
    await loadWorkflowVersions();
    await loadSettings(version.id);
  } catch (error) { showToast(error.message); }
});

$("#new-default-workflow-version").addEventListener("click", async () => {
  const name = askWorkflowVersionName("系统内置规则恢复版");
  if (!name) return;
  try {
    const { workflow_version: version } = await api("/admin/workflow-versions", {
      method: "POST",
      body: JSON.stringify({ name, use_system_defaults: true }),
    });
    showToast("已创建使用系统内置提示词与默认数值的试验版");
    await loadWorkflowVersions();
    await loadSettings(version.id);
  } catch (error) { showToast(error.message); }
});

$("#restore-workflow-version").addEventListener("click", async () => {
  if (!confirm("确定清空当前试验版的全部自定义提示词，并恢复系统内置规则与默认质量数值？")) return;
  try {
    await api(`/admin/workflow-versions/${state.selectedSettingsWorkflowId}/restore-default`, {
      method: "POST", body: "{}",
    });
    showToast("当前试验版已恢复系统内置提示词与默认质量数值");
    await loadSettings(state.selectedSettingsWorkflowId);
  } catch (error) { showToast(error.message); }
});

$("#delete-workflow-version").addEventListener("click", async () => {
  const versionId = state.selectedSettingsWorkflowId;
  const status = state.selectedSettingsWorkflowStatus;
  const name = $("#workflow-version-select").selectedOptions[0]?.textContent || "当前版本";
  if (!versionId || status === "stable") {
    showToast("当前员工稳定版不能删除，请先发布其他版本");
    return;
  }
  if (!confirm(`确定删除“${name}”？已有项目会继续使用创建时保存的工作流快照。`)) return;
  if (status === "archived" && !confirm("二次确认：这是历史版，删除后不能再用它回滚。确认继续？")) return;
  try {
    const result = await api(`/admin/workflow-versions/${versionId}`, {
      method: "DELETE",
      body: "{}",
    });
    showToast(result.preserved_project_count
      ? `版本已删除，${result.preserved_project_count}个已有项目继续使用原快照`
      : "工作流版本已删除");
    await loadWorkflowVersions();
    await loadSettings(state.stableWorkflowId);
  } catch (error) { showToast(error.message); }
});

$("#publish-workflow-version").addEventListener("click", async () => {
  if (!confirm("确定发布为员工稳定版？旧稳定版会保留为历史版，已有项目不会改变。")) return;
  try {
    const { workflow_version: version } = await api(`/admin/workflow-versions/${state.selectedSettingsWorkflowId}/publish`, {
      method: "POST", body: "{}",
    });
    showToast("已发布为员工稳定版");
    state.system = await api("/system");
    await loadWorkflowVersions();
    await loadSettings(version.id);
  } catch (error) { showToast(error.message); }
});

$$("[data-prompt-tab]").forEach(button => button.addEventListener("click", () => {
  $$("[data-prompt-tab]").forEach(node => node.classList.toggle("active", node === button));
  $$("[data-prompt-editor]").forEach(node => node.classList.toggle("hidden", node.dataset.promptEditor !== button.dataset.promptTab));
}));

const PROMPT_STAGES = ["metadata", "breakdown", "breakdown_review", "script", "script_review"];
const QUALITY_RULE_KEYS = [
  "episodes_per_6_min", "episodes_per_6_max", "episodes_per_6_high_density_max",
  "plot_points_min", "plot_points_max",
  "script_han_min", "script_han_max",
  "scene_min", "scene_max",
  "dialogue_lines_min", "dialogue_run_max",
  "adjacent_action_max", "same_speaker_unmerged_max", "single_dialogue_han_max",
  "dialogue_ratio_min", "dialogue_ratio_max",
  "action_ratio_min", "action_ratio_max",
  "narration_ratio_min", "narration_ratio_max",
];

async function loadGenerationSchemes(versionId = state.selectedGenerationSchemeId) {
  if (state.user.role !== "admin") return;
  try {
    const listing = await api("/admin/one-shot-versions");
    const versions = listing.versions || [];
    const selectedId = Number(versionId || listing.stable_id || versions[0]?.id);
    const select = $("#generation-scheme-select");
    select.innerHTML = versions.map(version => {
      const suffix = { stable: "员工稳定版", draft: "试验版", archived: "历史版" }[version.status] || version.status;
      return `<option value="${version.id}">${escapeHtml(version.name)}（${suffix}）</option>`;
    }).join("");
    select.value = String(selectedId || "");
    if (!selectedId) return;
    const { version } = await api(`/one-shot-versions/${selectedId}`);
    state.selectedGenerationSchemeId = version.id;
    state.selectedGenerationSchemeStatus = version.status;
    const form = $("#generation-scheme-form");
    ["name", "description", "reasoning_effort", "max_session_turns", "default_context"].forEach(key => {
      form.elements[key].value = version[key] ?? "";
    });
    loadWorkflowFileEditor(
      "#generation-workflow-file",
      "#generation-workflow-content",
      "generationSchemeWorkflowFiles",
      version.workflow_files,
    );
    fillQualityFields(form, "generation_quality_", version.quality_settings);
    const editable = version.status === "draft";
    $$('input, textarea, select', form).forEach(field => {
      if (field.id !== "generation-scheme-select") field.disabled = !editable;
    });
    $("#save-generation-scheme").disabled = !editable;
    $("#publish-generation-scheme").disabled = version.status === "stable";
    $("#delete-generation-scheme").disabled = version.status === "stable";
    const status = $("#generation-scheme-status");
    status.textContent = { stable: "员工稳定版 · 已锁定", draft: "试验版 · 可编辑", archived: "历史版 · 已锁定" }[version.status] || version.status;
    status.style.color = editable ? "var(--accent)" : "var(--muted)";
    showError("#generation-scheme-error", "");
  } catch (error) {
    showError("#generation-scheme-error", error.message);
  }
}

$("#generation-scheme-select").addEventListener("change", event => loadGenerationSchemes(Number(event.target.value)));

$("#generation-workflow-file").addEventListener("change", () => {
  switchWorkflowFile(
    "#generation-workflow-file",
    "#generation-workflow-content",
    "generationSchemeWorkflowFiles",
  );
});

$("#clone-generation-scheme").addEventListener("click", async () => {
  const current = $("#generation-scheme-select").selectedOptions[0]?.textContent || "当前方案";
  const name = window.prompt("请输入新试验版名称", `${current.replace(/（.*?）/g, "")}优化试验版`)?.trim();
  if (!name) return;
  try {
    const { version } = await api("/admin/one-shot-versions", {
      method: "POST", body: JSON.stringify({ name, clone_from: state.selectedGenerationSchemeId }),
    });
    await loadOneShotVersions();
    await loadGenerationSchemes(version.id);
    showToast("已复制为可编辑试验版");
  } catch (error) { showToast(error.message); }
});

$("#new-generation-scheme").addEventListener("click", async () => {
  const name = window.prompt("请输入新方案名称", "高质量同会话试验版")?.trim();
  if (!name) return;
  try {
    const { version } = await api("/admin/one-shot-versions", {
      method: "POST", body: JSON.stringify({ name, use_system_defaults: true }),
    });
    await loadOneShotVersions();
    await loadGenerationSchemes(version.id);
    showToast("已创建高质量默认试验版");
  } catch (error) { showToast(error.message); }
});

$("#generation-scheme-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $("#save-generation-scheme");
  button.disabled = true;
  try {
    saveCurrentWorkflowFile(
      "#generation-workflow-file",
      "#generation-workflow-content",
      "generationSchemeWorkflowFiles",
    );
    const body = {
      name: form.elements.name.value,
      description: form.elements.description.value,
      reasoning_effort: form.elements.reasoning_effort.value,
      max_session_turns: Number(form.elements.max_session_turns.value),
      default_context: form.elements.default_context.value,
      workflow_files: state.generationSchemeWorkflowFiles,
      quality_settings: collectQualityFields(form, "generation_quality_"),
    };
    const { version } = await api(`/admin/one-shot-versions/${state.selectedGenerationSchemeId}`, {
      method: "PATCH", body: JSON.stringify(body),
    });
    await loadOneShotVersions();
    await loadGenerationSchemes(version.id);
    showToast("生成方案试验版已保存");
  } catch (error) {
    showError("#generation-scheme-error", error.message);
  } finally {
    button.disabled = state.selectedGenerationSchemeStatus !== "draft";
  }
});

$("#publish-generation-scheme").addEventListener("click", async () => {
  if (!confirm("确定发布为员工稳定版？旧稳定版会保留为历史版，已有项目不会改变。")) return;
  try {
    const { version } = await api(`/admin/one-shot-versions/${state.selectedGenerationSchemeId}/publish`, { method: "POST", body: "{}" });
    state.system = await api("/system");
    await loadOneShotVersions();
    await loadGenerationSchemes(version.id);
    showToast("生成方案已发布为员工稳定版");
  } catch (error) { showToast(error.message); }
});

$("#delete-generation-scheme").addEventListener("click", async () => {
  if (state.selectedGenerationSchemeStatus === "stable") return showToast("当前稳定版不能删除");
  if (!confirm("确定删除当前生成方案？已有项目仍保留完整快照。")) return;
  try {
    const result = await api(`/admin/one-shot-versions/${state.selectedGenerationSchemeId}`, { method: "DELETE", body: "{}" });
    await loadOneShotVersions();
    await loadGenerationSchemes(state.stableOneShotVersionId);
    showToast(result.preserved_project_count ? `已删除，${result.preserved_project_count}个项目继续使用原快照` : "生成方案已删除");
  } catch (error) { showToast(error.message); }
});

function applyPromptMode(stage, isOverride) {
  const form = $("#settings-form");
  const box = form && form.elements[`mode_${stage}`];
  if (box) box.checked = isOverride;
  const editor = $(`[data-prompt-editor="${stage}"]`);
  if (editor) editor.classList.toggle("override-on", isOverride);
}

PROMPT_STAGES.forEach(stage => {
  const box = document.querySelector(`[name="mode_${stage}"]`);
  if (box) box.addEventListener("change", () => applyPromptMode(stage, box.checked));
});

$("#test-api-key").addEventListener("click", async () => {
  const form = $("#settings-form");
  const btn = $("#test-api-key");
  const result = $("#key-test-result");
  const apiKey = form.elements.ai_api_key.value.trim();
  if (!apiKey) {
    result.style.display = "block";
    result.className = "form-hint error";
    result.textContent = "请先输入 API Key";
    return;
  }
  btn.disabled = true;
  btn.textContent = "测试中…";
  result.style.display = "block";
  result.className = "form-hint";
  result.textContent = "正在连接 API 服务器…";
  try {
    const body = {
      ai_provider: form.elements.ai_provider.value,
      ai_model: form.elements.ai_model.value,
      ai_base_url: form.elements.ai_base_url.value,
      ai_api_key: apiKey,
    };
    const resp = await api("/admin/settings/test-key", { method: "POST", body: JSON.stringify(body) });
    result.className = "form-hint success";
    result.textContent = resp.message || "✓ API Key 有效";
  } catch (error) {
    result.className = "form-hint error";
    result.textContent = "✗ " + error.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "测试连接";
  }
});

$("#settings-form").addEventListener("submit", async event => {
  event.preventDefault();
  showError("#settings-error", "");
  const form = event.currentTarget;
  const button = $("#save-settings");
  button.disabled = true;
  button.textContent = "正在保存…";
  const body = {
    ai_provider: form.elements.ai_provider.value,
    ai_model: form.elements.ai_model.value,
    ai_base_url: form.elements.ai_base_url.value,
    ai_api_key: form.elements.ai_api_key.value,
    batch_size: Number(form.elements.batch_size.value),
    retry_settings: {
      upstream_api_retries: Number(form.elements.upstream_api_retries.value),
      turn_limit_resumes: Number(form.elements.turn_limit_resumes.value),
    },
    one_shot_system_prompt: form.elements.one_shot_system_prompt.value,
    one_shot_default_context: form.elements.one_shot_default_context.value,
    workflow_version_id: state.selectedSettingsWorkflowId,
  };
  if (state.selectedSettingsWorkflowStatus === "draft") {
    body.quality_settings = Object.fromEntries(
      QUALITY_RULE_KEYS.map(key => [key, Number(form.elements[`quality_${key}`].value)])
    );
    body.prompts = {
      metadata: form.elements.prompt_metadata.value,
      breakdown: form.elements.prompt_breakdown.value,
      breakdown_review: form.elements.prompt_breakdown_review.value,
      script: form.elements.prompt_script.value,
      script_review: form.elements.prompt_script_review.value,
    };
    body.prompt_modes = Object.fromEntries(
      PROMPT_STAGES.map(stage => [stage, form.elements[`mode_${stage}`].checked ? "override" : "append"])
    );
  }
  try {
    await api("/admin/settings", { method: "PATCH", body: JSON.stringify(body) });
    state.system = await api("/system");
    updateBatchCopy();
    updateModelStatus();
    const keySaved = body.ai_api_key ? "，API Key 已保存" : "";
    showToast(`系统设置已保存${keySaved}`);
    loadSettings(state.selectedSettingsWorkflowId);
  } catch (error) {
    showError("#settings-error", error.message);
  } finally {
    button.disabled = false;
    button.textContent = "确定";
  }
});

boot().catch(error => {
  document.body.innerHTML = `<div style="padding:40px;font-family:sans-serif">系统启动失败：${escapeHtml(error.message)}</div>`;
});

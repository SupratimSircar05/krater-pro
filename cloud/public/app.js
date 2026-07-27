import {
  MAX_CHAT_PROMPT_BYTES,
  isChatPromptWithinLimit,
  pruneChatHistory,
} from "./chat-history.js";

(() => {
  "use strict";

  const MODEL = "moonshotai/kimi-k3";
  const MAX_FILES = 100;
  const MAX_FILE_BYTES = 128 * 1024;
  const MAX_SNAPSHOT_BYTES = 512 * 1024;
  const MAX_SAVE_RETRIES = 5;
  const encoder = new TextEncoder();

  let kraterApiKey = "";
  let currentUser = null;
  let projects = [];
  let activeProject = null;
  let activePath = "";
  let openPaths = [];
  let dirtyPaths = new Set();
  let authMode = "login";
  let saveTimer = 0;
  let saveInFlight = false;
  let saveQueued = false;
  let saveRevision = 0;
  let saveRetryAttempt = 0;
  let projectLoadRevision = 0;
  let chatInFlight = false;
  let sessionUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let pendingConfirmation = null;
  let historyTrimNoticeShown = false;

  const byId = (id) => document.getElementById(id);

  const marketingView = byId("marketing-view");
  const labView = byId("lab-view");
  const siteHeader = byId("site-header");
  const siteFooter = byId("site-footer");
  const authDialog = byId("auth-dialog");
  const keyDialog = byId("key-dialog");
  const projectDialog = byId("project-dialog");
  const fileDialog = byId("file-dialog");
  const confirmDialog = byId("confirm-dialog");
  const cloudInfoDialog = byId("cloud-info-dialog");
  const authForm = byId("auth-form");
  const keyForm = byId("key-form");
  const projectForm = byId("project-form");
  const fileForm = byId("file-form");
  const projectList = byId("project-list");
  const projectEmpty = byId("project-empty");
  const fileTabs = byId("file-tabs");
  const codeEditor = byId("code-editor");
  const lineNumbers = byId("line-numbers");
  const editorEmpty = byId("editor-empty");
  const editorWorkspace = byId("editor-workspace");
  const chatMessages = byId("chat-messages");
  const chatInput = byId("chat-input");
  const sendChatButton = byId("send-chat-button");
  const accountPopover = byId("account-popover");
  const projectRail = document.querySelector(".project-rail");
  const chatPane = document.querySelector(".chat-pane");

  class ApiError extends Error {
    constructor(message, status, code = "", retryAfterMs = null) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.code = code;
      this.retryAfterMs = retryAfterMs;
    }
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const response = await fetch(path, {
      ...options,
      headers,
      credentials: "include",
    });

    const contentType = response.headers.get("content-type") || "";
    let payload = null;
    if (response.status !== 204 && contentType.includes("application/json")) {
      payload = await response.json().catch(() => null);
    }

    if (!response.ok) {
      const message =
        typeof payload?.error === "string"
          ? payload.error
          : typeof payload?.message === "string"
            ? payload.message
            : typeof payload?.error?.message === "string"
              ? payload.error.message
              : response.status === 401
                ? "Your session has expired. Please sign in again."
                : "Krater Pro could not complete that request.";
      const code = typeof payload?.error?.code === "string" ? payload.error.code : "";
      throw new ApiError(message, response.status, code, parseRetryAfter(response.headers.get("retry-after")));
    }

    return payload || {};
  }

  function openDialog(dialog) {
    if (!dialog.open) {
      dialog.showModal();
    }
    document.body.classList.add("modal-open");
  }

  function closeDialog(dialog) {
    if (dialog.open) {
      dialog.close();
    }
    if (!document.querySelector("dialog[open]")) {
      document.body.classList.remove("modal-open");
    }
  }

  function bindDialog(dialog, closeButton, onClose) {
    closeButton.addEventListener("click", () => closeDialog(dialog));
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) {
        closeDialog(dialog);
      }
    });
    dialog.addEventListener("close", () => {
      document.body.classList.remove("modal-open");
      if (onClose) onClose();
    });
  }

  function toast(message, type = "success") {
    const element = document.createElement("div");
    element.className = `toast${type === "error" ? " error" : ""}`;
    element.textContent = message;
    byId("toast-region").append(element);
    window.setTimeout(() => element.remove(), 4200);
  }

  function setButtonBusy(button, busy, busyLabel, idleLabel) {
    button.disabled = busy;
    button.textContent = busy ? busyLabel : idleLabel;
  }

  function clearSensitiveState() {
    kraterApiKey = "";
    const input = byId("api-key-input");
    input.value = "";
    input.type = "password";
    byId("toggle-key-button").textContent = "Show";
    byId("toggle-key-button").setAttribute("aria-label", "Show API key");
    updateKeyStatus();
  }

  function updateKeyStatus() {
    const pill = byId("api-connection-pill");
    if (kraterApiKey) {
      pill.classList.add("connected");
      pill.lastChild.textContent = " Kimi K3 connected";
      byId("connect-key-button").textContent = "Change API key";
      byId("popover-connect-key-button").textContent = "Change Krater API key";
    } else {
      pill.classList.remove("connected");
      pill.lastChild.textContent = " API key needed";
      byId("connect-key-button").textContent = "Connect Krater.ai";
      byId("popover-connect-key-button").textContent = "Connect Krater.ai";
    }
    updateSendState();
  }

  function updateAuthUi() {
    const signedIn = Boolean(currentUser);
    const authLabel = signedIn ? "Your Cloud Lab" : "Sign in";
    byId("header-auth-button").textContent = authLabel;
    byId("mobile-auth-button").textContent = authLabel;
    byId("footer-signin-button").textContent = authLabel;

    if (signedIn) {
      const email = currentUser.email || "Account";
      byId("account-email").textContent = email;
      byId("account-avatar").textContent = email.slice(0, 1).toUpperCase();
    }
  }

  function showMarketing() {
    clearSensitiveState();
    marketingView.hidden = false;
    siteHeader.hidden = false;
    siteFooter.hidden = false;
    labView.hidden = true;
    document.body.classList.remove("lab-open");
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    accountPopover.hidden = true;
    byId("account-button").setAttribute("aria-expanded", "false");
  }

  async function showLab() {
    if (!currentUser) {
      showAuth("login");
      return;
    }

    marketingView.hidden = true;
    siteHeader.hidden = true;
    siteFooter.hidden = true;
    labView.hidden = false;
    document.body.classList.add("lab-open");
    history.replaceState(null, "", `${location.pathname}${location.search}#lab`);
    setMobilePanelDefaults();

    try {
      await loadProjects();
    } catch (error) {
      handleProtectedError(error);
    }
  }

  function showAuth(mode) {
    setAuthMode(mode);
    byId("auth-error").textContent = "";
    openDialog(authDialog);
    window.setTimeout(() => byId("auth-email").focus(), 20);
  }

  function setAuthMode(mode) {
    authMode = mode;
    const registering = mode === "register";
    byId("login-tab").setAttribute("aria-selected", String(!registering));
    byId("register-tab").setAttribute("aria-selected", String(registering));
    byId("auth-title").textContent = registering ? "Create your Cloud Lab" : "Welcome back";
    byId("auth-copy").textContent = registering
      ? "Save virtual projects and continue your work in future sessions."
      : "Sign in to continue your saved Cloud Lab projects.";
    byId("account-disclosure").hidden = !registering;
    byId("auth-submit-button").textContent = registering ? "Create account" : "Sign in";
    const password = byId("auth-password");
    password.autocomplete = registering ? "new-password" : "current-password";
  }

  async function handleAuthSubmit(event) {
    event.preventDefault();
    const email = byId("auth-email").value.trim().toLowerCase();
    const password = byId("auth-password").value;
    const button = byId("auth-submit-button");
    const errorElement = byId("auth-error");
    errorElement.textContent = "";

    if (password.length < 12) {
      errorElement.textContent = "Use at least 12 characters for your password.";
      return;
    }

    const action = authMode === "register" ? "Create account" : "Sign in";
    setButtonBusy(button, true, "Please wait…", action);

    try {
      const response = await api(`/api/auth/${authMode}`, {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      currentUser = response.user;
      byId("auth-password").value = "";
      updateAuthUi();
      closeDialog(authDialog);
      toast(authMode === "register" ? "Your Cloud Lab is ready." : "Welcome back.");
      await showLab();
    } catch (error) {
      errorElement.textContent = readableError(error);
    } finally {
      setButtonBusy(button, false, "Please wait…", action);
    }
  }

  async function logout() {
    accountPopover.hidden = true;
    try {
      await flushSave();
      await api("/api/auth/logout", { method: "POST" });
      resetAccountState();
      showMarketing();
      toast("You are signed out.");
    } catch (error) {
      if (error instanceof ApiError && error.code === "unauthorized") {
        resetAccountState();
        showMarketing();
        toast("Your expired session was cleared.");
      } else {
        toast("Could not sign out. Your session is still active; please try again.", "error");
      }
    }
  }

  function resetAccountState() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    saveInFlight = false;
    saveQueued = false;
    saveRetryAttempt = 0;
    currentUser = null;
    projects = [];
    activeProject = null;
    activePath = "";
    openPaths = [];
    dirtyPaths = new Set();
    sessionUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    historyTrimNoticeShown = false;
    clearSensitiveState();
    updateAuthUi();
    renderProjects();
    renderActiveProject();
    renderUsage();
  }

  function handleProtectedError(error) {
    if (error instanceof ApiError && error.code === "unauthorized") {
      resetAccountState();
      showMarketing();
      showAuth("login");
      byId("auth-error").textContent = "Your session expired. Please sign in again.";
      return;
    }
    toast(readableError(error), "error");
  }

  function readableError(error) {
    if (error instanceof ApiError) return error.message;
    if (error instanceof TypeError) return "Could not reach Krater Pro. Check your connection and try again.";
    return "Something went wrong. Please try again.";
  }

  async function connectKey(event) {
    event.preventDefault();
    const input = byId("api-key-input");
    const candidate = input.value.trim();
    const button = byId("key-submit-button");
    const errorElement = byId("key-error");
    errorElement.textContent = "";

    if (!candidate) {
      errorElement.textContent = "Paste your Krater.ai API key.";
      return;
    }

    input.value = "";
    input.type = "password";
    setButtonBusy(button, true, "Validating…", "Validate and connect");

    try {
      const response = await api("/api/key/validate", {
        method: "POST",
        headers: { "x-krater-api-key": candidate },
      });
      if (!response.valid || response.model !== MODEL) {
        throw new ApiError("This key could not access Kimi K3.", 400);
      }
      kraterApiKey = candidate;
      updateKeyStatus();
      closeDialog(keyDialog);
      toast("Kimi K3 is connected for this page session.");
      chatInput.focus();
    } catch (error) {
      kraterApiKey = "";
      updateKeyStatus();
      if (error instanceof ApiError && error.code === "unauthorized") {
        closeDialog(keyDialog);
        handleProtectedError(error);
      } else {
        errorElement.textContent = readableError(error);
      }
    } finally {
      setButtonBusy(button, false, "Validating…", "Validate and connect");
    }
  }

  function showKeyDialog() {
    byId("key-error").textContent = "";
    accountPopover.hidden = true;
    byId("account-button").setAttribute("aria-expanded", "false");
    openDialog(keyDialog);
    window.setTimeout(() => byId("api-key-input").focus(), 20);
  }

  function defaultSnapshot(name) {
    return {
      files: [
        {
          path: "README.md",
          content: `# ${name}\n\nWelcome to your Krater Pro Cloud Lab project.\n\nDescribe what you want to build, add virtual files, then ask Krater Agent for help.\n`,
        },
      ],
      messages: [],
      activePath: "README.md",
    };
  }

  function normalizeSnapshot(value, name) {
    const fallback = defaultSnapshot(name || "Untitled project");
    if (!value || typeof value !== "object" || !Array.isArray(value.files)) {
      return fallback;
    }

    const paths = new Set();
    const files = [];
    for (const entry of value.files) {
      if (
        entry &&
        typeof entry.path === "string" &&
        typeof entry.content === "string" &&
        isValidPath(entry.path) &&
        !paths.has(entry.path)
      ) {
        paths.add(entry.path);
        files.push({ path: entry.path, content: entry.content });
      }
    }
    if (!files.length) files.push(fallback.files[0]);

    const history = pruneChatHistory(value.messages);
    if (history.trimmed) notifyHistoryTrimmed();

    const requestedPath = typeof value.activePath === "string" ? value.activePath : "";
    return {
      files,
      messages: history.messages,
      activePath: files.some((file) => file.path === requestedPath) ? requestedPath : files[0].path,
    };
  }

  function notifyHistoryTrimmed() {
    if (historyTrimNoticeShown) return;
    historyTrimNoticeShown = true;
    window.setTimeout(
      () => toast("Older chat context was trimmed to keep this project within its saved-history limit."),
      0,
    );
  }

  function pruneSnapshotMessages(snapshot) {
    const history = pruneChatHistory(snapshot.messages);
    snapshot.messages = history.messages;
    if (history.trimmed) notifyHistoryTrimmed();
    return history;
  }

  async function loadProjects() {
    const response = await api("/api/projects");
    projects = Array.isArray(response.projects) ? response.projects : [];
    renderProjects();

    if (!projects.length) {
      activeProject = null;
      renderActiveProject();
      return;
    }

    const preferredId =
      activeProject && projects.some((project) => project.id === activeProject.id)
        ? activeProject.id
        : projects[0].id;
    await selectProject(preferredId);
  }

  async function selectProject(id) {
    if (!id) return;
    const revision = ++projectLoadRevision;
    setSaveStatus("Loading project…", "saving");

    try {
      if (activeProject && activeProject.id !== id) {
        await flushSave();
      }
      const response = await api(`/api/projects/${encodeURIComponent(id)}`);
      if (revision !== projectLoadRevision) return;

      const project = response.project;
      if (!project || typeof project.id !== "string") {
        throw new ApiError("The selected project could not be loaded.", 500);
      }

      activeProject = {
        ...project,
        snapshot: normalizeSnapshot(project.snapshot, project.name),
      };
      activePath = activeProject.snapshot.activePath;
      openPaths = [activePath];
      dirtyPaths = new Set();
      renderProjects();
      renderActiveProject();
      setSaveStatus("Saved to Cloud Lab", "saved");
    } catch (error) {
      if (revision === projectLoadRevision) handleProtectedError(error);
    }
  }

  async function createProject(event) {
    event.preventDefault();
    const input = byId("project-name-input");
    const errorElement = byId("project-error");
    const name = input.value.trim();
    const submit = projectForm.querySelector('button[type="submit"]');
    errorElement.textContent = "";

    if (!name) {
      errorElement.textContent = "Enter a project name.";
      return;
    }

    setButtonBusy(submit, true, "Creating…", "Create project");
    try {
      const response = await api("/api/projects", {
        method: "POST",
        body: JSON.stringify({ name, snapshot: defaultSnapshot(name) }),
      });
      const project = response.project;
      if (!project) throw new ApiError("The project could not be created.", 500);
      projects.unshift({
        id: project.id,
        name: project.name,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      });
      closeDialog(projectDialog);
      input.value = "";
      toast(`${name} is ready.`);
      await selectProject(project.id);
    } catch (error) {
      if (error instanceof ApiError && error.code === "unauthorized") {
        closeDialog(projectDialog);
        handleProtectedError(error);
      } else {
        errorElement.textContent = readableError(error);
      }
    } finally {
      setButtonBusy(submit, false, "Creating…", "Create project");
    }
  }

  async function deleteProject(project) {
    const confirmed = await askConfirmation(
      "Delete project?",
      `Delete “${project.name}” and all of its saved virtual files and conversation history? This cannot be undone.`,
      "Delete project",
    );
    if (!confirmed) return;

    try {
      await api(`/api/projects/${encodeURIComponent(project.id)}`, { method: "DELETE" });
      projects = projects.filter((item) => item.id !== project.id);
      if (activeProject?.id === project.id) {
        activeProject = null;
        activePath = "";
        openPaths = [];
        dirtyPaths = new Set();
      }
      renderProjects();
      renderActiveProject();
      toast("Project deleted.");
      if (!activeProject && projects[0]) await selectProject(projects[0].id);
    } catch (error) {
      handleProtectedError(error);
    }
  }

  function renderProjects() {
    projectList.replaceChildren();
    projectEmpty.hidden = projects.length > 0;

    for (const project of projects) {
      const item = document.createElement("div");
      item.className = `project-item${activeProject?.id === project.id ? " active" : ""}`;

      const button = document.createElement("button");
      button.type = "button";
      button.className = "project-select";
      button.setAttribute("aria-current", activeProject?.id === project.id ? "true" : "false");
      button.addEventListener("click", () => selectProject(project.id));

      const icon = document.createElement("span");
      icon.className = "project-item__icon";
      icon.textContent = "◇";

      const text = document.createElement("span");
      text.className = "project-item__text";
      const title = document.createElement("strong");
      title.textContent = project.name;
      const updated = document.createElement("span");
      updated.textContent = formatRelativeTime(project.updatedAt);
      text.append(title, updated);

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "project-delete";
      deleteButton.textContent = "×";
      deleteButton.setAttribute("aria-label", `Delete ${project.name}`);
      deleteButton.addEventListener("click", (event) => {
        event.stopPropagation();
        deleteProject(project);
      });

      button.append(icon, text);
      item.append(button, deleteButton);
      projectList.append(item);
    }
  }

  function renderActiveProject() {
    const hasProject = Boolean(activeProject);
    editorEmpty.hidden = hasProject;
    editorWorkspace.hidden = !hasProject;
    byId("new-file-button").disabled = !hasProject;
    byId("clear-chat-button").disabled = !hasProject;

    if (!hasProject) {
      fileTabs.replaceChildren();
      codeEditor.value = "";
      byId("file-breadcrumb").textContent = "";
      setSaveStatus("No project selected");
      renderMessages([]);
      updateSendState();
      return;
    }

    if (!activeProject.snapshot.files.some((file) => file.path === activePath)) {
      activePath = activeProject.snapshot.files[0]?.path || "";
    }
    if (activePath && !openPaths.includes(activePath)) openPaths.push(activePath);
    activeProject.snapshot.activePath = activePath;

    renderTabs();
    const file = getActiveFile();
    codeEditor.value = file?.content || "";
    byId("file-breadcrumb").textContent = `${activeProject.name} / ${activePath}`;
    byId("file-language").textContent = languageForPath(activePath);
    updateLineNumbers();
    updateCursorPosition();
    renderMessages(activeProject.snapshot.messages);
    updateSendState();
  }

  function renderTabs() {
    fileTabs.replaceChildren();
    for (const path of openPaths) {
      if (!activeProject.snapshot.files.some((file) => file.path === path)) continue;
      const tab = document.createElement("div");
      tab.className = `file-tab${path === activePath ? " active" : ""}`;
      tab.setAttribute("role", "tab");
      tab.tabIndex = 0;
      tab.setAttribute("aria-selected", String(path === activePath));
      tab.title = path;
      tab.addEventListener("click", () => openFile(path));
      tab.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openFile(path);
        }
      });

      const name = document.createElement("span");
      name.className = "file-tab__name";
      name.textContent = path.split("/").pop() || path;
      tab.append(name);

      if (dirtyPaths.has(path)) {
        const dirty = document.createElement("span");
        dirty.className = "file-tab__dirty";
        dirty.setAttribute("aria-label", "Unsaved changes");
        tab.append(dirty);
      }

      const close = document.createElement("button");
      close.type = "button";
      close.className = "file-tab__close";
      close.textContent = "×";
      close.setAttribute("aria-label", `Close ${path}`);
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        closeFile(path);
      });
      tab.append(close);
      fileTabs.append(tab);
    }
  }

  function openFile(path) {
    if (!activeProject?.snapshot.files.some((file) => file.path === path)) return;
    activePath = path;
    activeProject.snapshot.activePath = path;
    if (!openPaths.includes(path)) openPaths.push(path);
    renderActiveProject();
    scheduleSave(false);
    codeEditor.focus();
  }

  function closeFile(path) {
    const index = openPaths.indexOf(path);
    if (index === -1) return;
    openPaths.splice(index, 1);
    if (activePath === path) {
      activePath = openPaths[Math.max(0, index - 1)] || activeProject.snapshot.files[0]?.path || "";
      if (activePath && !openPaths.includes(activePath)) openPaths.push(activePath);
      activeProject.snapshot.activePath = activePath;
    }
    renderActiveProject();
  }

  function createFile(event) {
    event.preventDefault();
    const input = byId("file-path-input");
    const errorElement = byId("file-error");
    const path = input.value.trim().replace(/^\.\//, "");
    errorElement.textContent = "";

    if (!activeProject) {
      closeDialog(fileDialog);
      return;
    }
    if (!isValidPath(path)) {
      errorElement.textContent = "Use a safe relative path without empty, . or .. segments.";
      return;
    }
    if (activeProject.snapshot.files.some((file) => file.path === path)) {
      errorElement.textContent = "That file already exists.";
      return;
    }
    if (activeProject.snapshot.files.length >= MAX_FILES) {
      errorElement.textContent = "This project already has the maximum of 100 files.";
      return;
    }

    activeProject.snapshot.files.push({ path, content: "" });
    activePath = path;
    activeProject.snapshot.activePath = path;
    if (!openPaths.includes(path)) openPaths.push(path);
    dirtyPaths.add(path);
    input.value = "";
    closeDialog(fileDialog);
    renderActiveProject();
    scheduleSave();
    codeEditor.focus();
  }

  function isValidPath(path) {
    if (!path || path.length > 180 || path.startsWith("/") || path.includes("\\") || /[\u0000-\u001f]/.test(path)) {
      return false;
    }
    const segments = path.split("/");
    return segments.every((segment) => segment && segment !== "." && segment !== "..");
  }

  function getActiveFile() {
    return activeProject?.snapshot.files.find((file) => file.path === activePath) || null;
  }

  function updateEditorContent() {
    const file = getActiveFile();
    if (!file) return;

    const bytes = encoder.encode(codeEditor.value).byteLength;
    if (bytes > MAX_FILE_BYTES) {
      codeEditor.value = file.content;
      toast("Cloud Lab files are limited to 128 KiB.", "error");
      return;
    }

    file.content = codeEditor.value;
    dirtyPaths.add(file.path);
    updateLineNumbers();
    updateCursorPosition();
    renderTabs();
    scheduleSave();
  }

  function scheduleSave(showSaving = true) {
    if (!activeProject) return;
    saveRevision += 1;
    saveRetryAttempt = 0;
    saveQueued = true;
    clearTimeout(saveTimer);
    if (showSaving) setSaveStatus("Saving…", "saving");
    saveTimer = window.setTimeout(() => flushSave(), 650);
  }

  async function flushSave() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    if (!activeProject || !saveQueued) return;
    if (saveInFlight) return;

    pruneSnapshotMessages(activeProject.snapshot);
    const serialized = JSON.stringify(activeProject.snapshot);
    if (encoder.encode(serialized).byteLength > MAX_SNAPSHOT_BYTES) {
      setSaveStatus("Project exceeds the 512 KiB Cloud Lab limit", "error");
      toast("Project is too large to save in Cloud Lab.", "error");
      return;
    }

    saveInFlight = true;
    saveQueued = false;
    const revision = saveRevision;
    const projectId = activeProject.id;
    const name = activeProject.name;
    const snapshot = JSON.parse(serialized);
    let retryDelay = null;

    try {
      const response = await api(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: "PUT",
        body: JSON.stringify({ name, snapshot }),
      });
      if (activeProject?.id === projectId) {
        const summary = projects.find((project) => project.id === projectId);
        if (summary && response.project?.updatedAt) summary.updatedAt = response.project.updatedAt;
        if (revision === saveRevision) {
          saveRetryAttempt = 0;
          dirtyPaths.clear();
          renderTabs();
          setSaveStatus("Saved to Cloud Lab", "saved");
        }
      }
    } catch (error) {
      const retryable =
        error instanceof TypeError ||
        (error instanceof ApiError && (error.status === 429 || error.status >= 500));
      if (error instanceof ApiError && error.code === "unauthorized") {
        saveQueued = false;
        handleProtectedError(error);
      } else if (retryable && saveRetryAttempt < MAX_SAVE_RETRIES) {
        saveQueued = true;
        saveRetryAttempt += 1;
        const exponential = Math.min(8_000, 500 * 2 ** (saveRetryAttempt - 1));
        const jitter = Math.floor(Math.random() * 251);
        retryDelay =
          error instanceof ApiError && error.retryAfterMs !== null
            ? error.retryAfterMs
            : exponential + jitter;
        const waitLabel =
          retryDelay === 0 ? "now" : `in ${Math.max(1, Math.ceil(retryDelay / 1000))}s`;
        setSaveStatus(
          `Save retry ${saveRetryAttempt}/${MAX_SAVE_RETRIES} ${waitLabel} — changes remain unsaved`,
          "saving",
        );
      } else if (retryable) {
        saveQueued = false;
        setSaveStatus("Autosave paused — changes remain unsaved", "error");
        toast("Autosave could not reconnect. Edit again or press ⌘S to retry.", "error");
      } else {
        saveQueued = false;
        setSaveStatus("Could not save", "error");
        toast(readableError(error), "error");
      }
    } finally {
      saveInFlight = false;
      if (saveQueued && activeProject?.id === projectId) {
        clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => flushSave(), retryDelay ?? 250);
      }
    }
  }

  function setSaveStatus(text, state = "") {
    const element = byId("save-status");
    element.textContent = text;
    element.className = state;
  }

  function updateLineNumbers() {
    const count = Math.max(1, codeEditor.value.split("\n").length);
    const values = [];
    for (let index = 1; index <= count; index += 1) values.push(String(index));
    lineNumbers.textContent = values.join("\n");
    lineNumbers.scrollTop = codeEditor.scrollTop;
  }

  function updateCursorPosition() {
    const before = codeEditor.value.slice(0, codeEditor.selectionStart);
    const lines = before.split("\n");
    byId("cursor-position").textContent = `Ln ${lines.length}, Col ${lines.at(-1).length + 1}`;
  }

  function languageForPath(path) {
    const extension = path.split(".").pop()?.toLowerCase();
    const languages = {
      js: "JavaScript",
      jsx: "JavaScript React",
      ts: "TypeScript",
      tsx: "TypeScript React",
      py: "Python",
      rs: "Rust",
      go: "Go",
      java: "Java",
      kt: "Kotlin",
      swift: "Swift",
      c: "C",
      h: "C header",
      cpp: "C++",
      cc: "C++",
      cs: "C#",
      rb: "Ruby",
      php: "PHP",
      html: "HTML",
      css: "CSS",
      scss: "SCSS",
      json: "JSON",
      yaml: "YAML",
      yml: "YAML",
      md: "Markdown",
      sh: "Shell",
      sql: "SQL",
      toml: "TOML",
      xml: "XML",
    };
    return languages[extension] || "Plain text";
  }

  function updateSendState() {
    const hasText = chatInput.value.trim().length > 0;
    sendChatButton.disabled = !activeProject || !hasText || chatInFlight;
  }

  async function sendChat(event) {
    event.preventDefault();
    const message = chatInput.value.trim();
    if (!message || !activeProject || chatInFlight) return;
    if (!isChatPromptWithinLimit(message)) {
      toast(
        `Prompts are limited to ${Math.round(MAX_CHAT_PROMPT_BYTES / 1024)} KiB of UTF-8 text. Shorten this message and try again.`,
        "error",
      );
      chatInput.focus();
      return;
    }
    if (!kraterApiKey) {
      showKeyDialog();
      return;
    }

    chatInFlight = true;
    updateSendState();
    const projectId = activeProject.id;
    const priorMessages = [...activeProject.snapshot.messages];
    chatInput.value = "";
    renderMessages([...priorMessages, { role: "user", content: message }], true);

    try {
      await flushSave();
      const response = await api("/api/chat", {
        method: "POST",
        headers: { "x-krater-api-key": kraterApiKey },
        body: JSON.stringify({ projectId, message, model: MODEL }),
      });
      if (activeProject?.id !== projectId) return;
      if (typeof response.reply !== "string" || !response.reply.trim()) {
        throw new ApiError("Kimi K3 returned an empty response.", 502);
      }

      activeProject.snapshot.messages.push(
        { role: "user", content: message },
        { role: "assistant", content: response.reply },
      );
      pruneSnapshotMessages(activeProject.snapshot);
      addUsage(response.usage);
      renderMessages(activeProject.snapshot.messages);
      scheduleSave();
    } catch (error) {
      if (activeProject?.id === projectId) renderMessages(priorMessages);
      if (error instanceof ApiError && error.code === "invalid_api_key") {
        clearSensitiveState();
        toast("Krater.ai rejected that key. Connect a valid key and try again.", "error");
        showKeyDialog();
      } else if (error instanceof ApiError && error.code === "unauthorized") {
        handleProtectedError(error);
      } else {
        toast(readableError(error), "error");
      }
    } finally {
      chatInFlight = false;
      updateSendState();
      chatInput.focus();
    }
  }

  function renderMessages(messages, thinking = false) {
    chatMessages.replaceChildren();
    if (!messages.length && !thinking) {
      const welcome = document.createElement("div");
      welcome.className = "welcome-message";
      const orb = document.createElement("span");
      orb.className = "agent-orb agent-orb--large";
      orb.textContent = "◉";
      const heading = document.createElement("h2");
      heading.textContent = "What are we building?";
      const copy = document.createElement("p");
      copy.textContent =
        "I can reason about the files in this virtual project, explain code, draft changes, and help debug with Kimi K3.";
      welcome.append(orb, heading, copy);
      chatMessages.append(welcome);
      return;
    }

    for (const message of messages) {
      const element = document.createElement("div");
      element.className = `chat-message chat-message--${message.role}`;
      if (message.role === "assistant") {
        appendSafeMarkdown(element, message.content);
      } else {
        element.textContent = message.content;
      }
      chatMessages.append(element);
    }

    if (thinking) {
      const element = document.createElement("div");
      element.className = "chat-message chat-message--thinking";
      const dots = document.createElement("span");
      dots.className = "thinking-dots";
      dots.append(document.createElement("i"), document.createElement("i"), document.createElement("i"));
      const label = document.createElement("span");
      label.textContent = "Kimi K3 is reasoning…";
      element.append(dots, label);
      chatMessages.append(element);
    }
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function appendSafeMarkdown(container, source) {
    const sections = String(source).split(/(```[\s\S]*?```)/g);
    for (const section of sections) {
      if (!section) continue;
      if (section.startsWith("```") && section.endsWith("```")) {
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        const raw = section.slice(3, -3);
        code.textContent = raw.replace(/^[a-zA-Z0-9_+#.-]+\n/, "");
        pre.append(code);
        container.append(pre);
        continue;
      }

      for (const line of section.split(/\n{2,}/)) {
        if (!line) continue;
        const paragraph = document.createElement("p");
        appendInlineCode(paragraph, line);
        container.append(paragraph);
      }
    }
  }

  function appendInlineCode(container, source) {
    const parts = source.split(/(`[^`\n]+`)/g);
    for (const part of parts) {
      if (part.startsWith("`") && part.endsWith("`")) {
        const code = document.createElement("code");
        code.textContent = part.slice(1, -1);
        container.append(code);
      } else {
        container.append(document.createTextNode(part));
      }
    }
  }

  function addUsage(usage) {
    if (!usage || typeof usage !== "object") return;
    for (const key of ["promptTokens", "completionTokens", "totalTokens"]) {
      const value = Number(usage[key]);
      if (Number.isFinite(value) && value >= 0) sessionUsage[key] += value;
    }
    renderUsage();
  }

  function renderUsage() {
    byId("usage-summary").textContent = `${sessionUsage.totalTokens.toLocaleString()} tokens`;
  }

  async function clearChat() {
    if (!activeProject || !activeProject.snapshot.messages.length) return;
    const confirmed = await askConfirmation(
      "Clear conversation?",
      "Remove the saved Krater Agent conversation from this project? Your virtual files will stay intact.",
      "Clear conversation",
    );
    if (!confirmed || !activeProject) return;
    activeProject.snapshot.messages = [];
    renderMessages([]);
    scheduleSave();
    toast("Conversation cleared.");
  }

  async function deleteAccount() {
    accountPopover.hidden = true;
    const confirmed = await askConfirmation(
      "Delete your account?",
      "Remove your Cloud Lab account, projects, virtual files, saved conversations, and sessions from the active service. This cannot be undone through Cloud Lab.",
      "Delete account",
    );
    if (!confirmed) return;

    try {
      await api("/api/account", { method: "DELETE" });
      resetAccountState();
      showMarketing();
      toast("Your Cloud Lab account was removed from the active service.");
    } catch (error) {
      handleProtectedError(error);
    }
  }

  function askConfirmation(title, copy, actionLabel) {
    if (pendingConfirmation) pendingConfirmation(false);
    byId("confirm-title").textContent = title;
    byId("confirm-copy").textContent = copy;
    byId("confirm-action-button").textContent = actionLabel;
    openDialog(confirmDialog);
    return new Promise((resolve) => {
      pendingConfirmation = resolve;
    });
  }

  function settleConfirmation(result) {
    if (!pendingConfirmation) return;
    const resolve = pendingConfirmation;
    pendingConfirmation = null;
    closeDialog(confirmDialog);
    resolve(result);
  }

  function normalizeTimestamp(value) {
    const numeric =
      typeof value === "number"
        ? value
        : typeof value === "string" && value.trim()
          ? Number(value)
          : Number.NaN;
    if (Number.isFinite(numeric)) {
      return Math.abs(numeric) < 1_000_000_000_000 ? numeric * 1000 : numeric;
    }
    return value;
  }

  function parseRetryAfter(value) {
    if (!value) return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(60_000, Math.ceil(seconds * 1000));
    }
    const date = Date.parse(value);
    if (!Number.isFinite(date)) return null;
    return Math.min(60_000, Math.max(0, date - Date.now()));
  }

  function formatRelativeTime(value) {
    const date = new Date(normalizeTimestamp(value));
    if (Number.isNaN(date.getTime())) return "Saved project";
    const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
    if (seconds < 60) return "Updated just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `Updated ${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `Updated ${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `Updated ${days}d ago`;
    return `Updated ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  }

  function setMobilePanelDefaults() {
    const tablet = window.matchMedia("(max-width: 760px)").matches;
    const phone = window.matchMedia("(max-width: 560px)").matches;
    chatPane.classList.toggle("mobile-hidden", tablet);
    projectRail.classList.toggle("mobile-hidden", phone);
    byId("mobile-agent-button").setAttribute("aria-expanded", "false");
    byId("mobile-projects-button").setAttribute("aria-expanded", String(!phone));
  }

  function toggleMobilePanel(panel) {
    if (panel === "agent") {
      const willOpen = chatPane.classList.contains("mobile-hidden");
      chatPane.classList.toggle("mobile-hidden", !willOpen);
      byId("mobile-agent-button").setAttribute("aria-expanded", String(willOpen));
      if (window.matchMedia("(max-width: 560px)").matches && willOpen) {
        projectRail.classList.add("mobile-hidden");
        byId("mobile-projects-button").setAttribute("aria-expanded", "false");
      }
    } else {
      const willOpen = projectRail.classList.contains("mobile-hidden");
      projectRail.classList.toggle("mobile-hidden", !willOpen);
      byId("mobile-projects-button").setAttribute("aria-expanded", String(willOpen));
      if (window.matchMedia("(max-width: 560px)").matches && willOpen) {
        chatPane.classList.add("mobile-hidden");
        byId("mobile-agent-button").setAttribute("aria-expanded", "false");
      }
    }
  }

  function bindEvents() {
    for (const id of [
      "header-launch-button",
      "mobile-launch-button",
      "hero-launch-button",
      "surface-launch-button",
      "footer-launch-button",
    ]) {
      byId(id).addEventListener("click", () => (currentUser ? showLab() : showAuth("register")));
    }
    for (const id of ["header-auth-button", "mobile-auth-button", "footer-signin-button"]) {
      byId(id).addEventListener("click", () => (currentUser ? showLab() : showAuth("login")));
    }

    byId("menu-button").addEventListener("click", () => {
      const menu = byId("mobile-nav");
      const opening = menu.hidden;
      menu.hidden = !opening;
      byId("menu-button").setAttribute("aria-expanded", String(opening));
    });
    for (const link of document.querySelectorAll("#mobile-nav a")) {
      link.addEventListener("click", () => {
        byId("mobile-nav").hidden = true;
        byId("menu-button").setAttribute("aria-expanded", "false");
      });
    }

    byId("login-tab").addEventListener("click", () => setAuthMode("login"));
    byId("register-tab").addEventListener("click", () => setAuthMode("register"));
    authForm.addEventListener("submit", handleAuthSubmit);
    keyForm.addEventListener("submit", connectKey);
    projectForm.addEventListener("submit", createProject);
    fileForm.addEventListener("submit", createFile);

    for (const id of ["connect-key-button", "popover-connect-key-button"]) {
      byId(id).addEventListener("click", showKeyDialog);
    }

    byId("toggle-key-button").addEventListener("click", () => {
      const input = byId("api-key-input");
      const showing = input.type === "text";
      input.type = showing ? "password" : "text";
      byId("toggle-key-button").textContent = showing ? "Show" : "Hide";
      byId("toggle-key-button").setAttribute("aria-label", showing ? "Show API key" : "Hide API key");
    });

    const showProjectDialog = () => {
      byId("project-error").textContent = "";
      openDialog(projectDialog);
      window.setTimeout(() => byId("project-name-input").focus(), 20);
    };
    byId("new-project-button").addEventListener("click", showProjectDialog);
    byId("empty-new-project-button").addEventListener("click", showProjectDialog);

    byId("new-file-button").addEventListener("click", () => {
      if (!activeProject) return;
      byId("file-error").textContent = "";
      openDialog(fileDialog);
      window.setTimeout(() => byId("file-path-input").focus(), 20);
    });

    codeEditor.addEventListener("input", updateEditorContent);
    codeEditor.addEventListener("click", updateCursorPosition);
    codeEditor.addEventListener("keyup", updateCursorPosition);
    codeEditor.addEventListener("scroll", () => {
      lineNumbers.scrollTop = codeEditor.scrollTop;
    });
    codeEditor.addEventListener("keydown", (event) => {
      if (event.key === "Tab") {
        event.preventDefault();
        const start = codeEditor.selectionStart;
        const end = codeEditor.selectionEnd;
        codeEditor.setRangeText("  ", start, end, "end");
        updateEditorContent();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        scheduleSave();
        flushSave();
      }
    });

    chatInput.addEventListener("input", updateSendState);
    chatInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        chatFormRequestSubmit();
      }
    });
    byId("chat-form").addEventListener("submit", sendChat);
    byId("clear-chat-button").addEventListener("click", clearChat);

    byId("account-button").addEventListener("click", () => {
      const opening = accountPopover.hidden;
      accountPopover.hidden = !opening;
      byId("account-button").setAttribute("aria-expanded", String(opening));
    });
    document.addEventListener("click", (event) => {
      if (!event.target.closest(".account-menu")) {
        accountPopover.hidden = true;
        byId("account-button").setAttribute("aria-expanded", "false");
      }
    });
    byId("logout-button").addEventListener("click", logout);
    byId("delete-account-button").addEventListener("click", deleteAccount);
    byId("lab-home-link").addEventListener("click", (event) => {
      event.preventDefault();
      flushSave();
      showMarketing();
    });
    byId("about-cloud-button").addEventListener("click", () => openDialog(cloudInfoDialog));
    byId("mobile-agent-button").addEventListener("click", () => toggleMobilePanel("agent"));
    byId("mobile-projects-button").addEventListener("click", () => toggleMobilePanel("projects"));

    byId("confirm-action-button").addEventListener("click", () => settleConfirmation(true));
    byId("confirm-cancel-button").addEventListener("click", () => settleConfirmation(false));
    byId("confirm-close-button").addEventListener("click", () => settleConfirmation(false));
    confirmDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      settleConfirmation(false);
    });
    confirmDialog.addEventListener("click", (event) => {
      if (event.target === confirmDialog) settleConfirmation(false);
    });

    bindDialog(authDialog, byId("auth-close-button"), () => {
      byId("auth-password").value = "";
      byId("auth-error").textContent = "";
    });
    bindDialog(keyDialog, byId("key-close-button"), () => {
      byId("api-key-input").value = "";
      byId("api-key-input").type = "password";
      byId("toggle-key-button").textContent = "Show";
      byId("key-error").textContent = "";
    });
    bindDialog(projectDialog, byId("project-close-button"), () => {
      byId("project-error").textContent = "";
    });
    bindDialog(fileDialog, byId("file-close-button"), () => {
      byId("file-error").textContent = "";
    });
    bindDialog(cloudInfoDialog, byId("cloud-info-close-button"));

    window.addEventListener("pagehide", clearSensitiveState);
    window.addEventListener("beforeunload", clearSensitiveState);
    window.addEventListener("resize", () => {
      if (!labView.hidden && !window.matchMedia("(max-width: 760px)").matches) {
        chatPane.classList.remove("mobile-hidden");
        projectRail.classList.remove("mobile-hidden");
      }
    });
  }

  function chatFormRequestSubmit() {
    if (typeof byId("chat-form").requestSubmit === "function") {
      byId("chat-form").requestSubmit();
    } else {
      sendChat(new Event("submit", { cancelable: true }));
    }
  }

  async function initialize() {
    bindEvents();
    updateAuthUi();
    updateKeyStatus();
    renderProjects();
    renderActiveProject();
    renderUsage();

    try {
      await api("/api/health");
      const response = await api("/api/me");
      currentUser = response.user || null;
      updateAuthUi();
      if (currentUser && location.hash === "#lab") await showLab();
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) {
        toast("Cloud Lab is temporarily unavailable. The product overview is still here.", "error");
      }
    }
  }

  initialize();
})();

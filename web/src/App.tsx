import {
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import kraterProMark from "./assets/krater-pro-mark.svg";
import { consumeSseEvents, type StreamEvent } from "./stream";
import { formatUsage } from "./usage";

type ApiStatus = {
  configured: boolean;
  model: string;
  cwd: string;
  projectId: string;
  projectKind: ProjectKind;
  version: string;
};

type Model = {
  id: string;
};

type ProjectKind = "local" | "github" | "scratch";

type Project = {
  id: string;
  name: string;
  kind: ProjectKind;
  path: string;
  source?: string;
};

type ProjectsPayload = {
  current: Project;
  currentId: string;
  projects: Project[];
};

type ProjectSourceDialog = "local" | "github" | null;

type ToolState = "running" | "approval" | "approved" | "success" | "error" | "denied";

type ToolActivity = {
  id: string;
  name: string;
  args?: unknown;
  output?: unknown;
  ok?: boolean;
  cached?: boolean;
  approvalId?: string;
  reason?: string;
  state: ToolState;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  tools?: ToolActivity[];
  usage?: Record<string, unknown>;
  streaming?: boolean;
};

const MODEL_STORAGE_KEY = "krater-pro:model";
const ADD_LOCAL_PROJECT = "__add-local-project__";
const ADD_GITHUB_PROJECT = "__add-github-project__";
const ADD_SCRATCH_PROJECT = "__add-scratch-project__";

const starterPrompts = [
  {
    label: "Explore this codebase",
    detail: "Map the architecture and explain how the pieces connect.",
    icon: "⌘",
  },
  {
    label: "Build a new feature",
    detail: "Plan and implement a polished feature in this project.",
    icon: "＋",
  },
  {
    label: "Find and fix a bug",
    detail: "Trace an issue to its root cause, then verify the fix.",
    icon: "◇",
  },
];

function initialModel() {
  try {
    return window.localStorage.getItem(MODEL_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function deleteSession(sessionId: string) {
  return fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    keepalive: true,
  }).catch(() => undefined);
}

function titleFromMessage(message: string) {
  const clean = message.replace(/\s+/g, " ").trim();
  return clean.length > 35 ? `${clean.slice(0, 35)}…` : clean;
}

function displayValue(value: unknown) {
  if (typeof value === "string") return value;
  if (value === undefined) return "";

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

async function responseError(response: Response, fallback: string) {
  const body = (await response.text()).trim();
  if (!body) return fallback;
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: unknown };
      message?: unknown;
    };
    if (typeof parsed.error?.message === "string") return parsed.error.message;
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // Plain-text errors are already suitable for display.
  }
  return body;
}

function toolLabel(name: string) {
  return name
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function projectKindLabel(kind: ProjectKind) {
  if (kind === "github") return "GitHub";
  if (kind === "scratch") return "Scratch";
  return "Local";
}

function upsertTool(tools: ToolActivity[] | undefined, next: ToolActivity) {
  const current = tools ?? [];
  const index = current.findIndex((tool) => tool.id === next.id);

  if (index === -1) return [...current, next];

  return current.map((tool, toolIndex) =>
    toolIndex === index ? { ...tool, ...next } : tool,
  );
}

function statusText(
  status: ApiStatus | null,
  apiKey: string,
  offline: boolean,
  credentialValidated: boolean,
) {
  if (offline) return "Server offline";
  if (credentialValidated) return "Krater validated";
  if (apiKey.trim()) return "Tab key configured";
  if (status?.configured) return "Key configured (unverified)";
  return "Key required";
}

function KraterMark({ small = false }: { small?: boolean }) {
  return (
    <img
      className={`krater-mark${small ? " krater-mark--small" : ""}`}
      src={kraterProMark}
      alt=""
      aria-hidden="true"
    />
  );
}

function ToolCard({
  tool,
  disabled,
  onApproval,
}: {
  tool: ToolActivity;
  disabled: boolean;
  onApproval: (tool: ToolActivity, approved: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(tool.state === "approval");
  const isPendingApproval = tool.state === "approval";
  const showOutput = tool.output !== undefined && tool.output !== "";

  useEffect(() => {
    if (tool.state === "approval") setExpanded(true);
  }, [tool.state]);

  return (
    <section className={`tool-card tool-card--${tool.state}`}>
      <button
        className="tool-card__summary"
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <span className="tool-card__symbol" aria-hidden="true">
          {tool.state === "success"
            ? "✓"
            : tool.state === "error" || tool.state === "denied"
              ? "!"
              : tool.state === "approval"
                ? "?"
                : "›"}
        </span>
        <span className="tool-card__heading">
          <strong>{toolLabel(tool.name)}</strong>
          <span>
            {tool.state === "approval"
              ? "Permission needed"
              : tool.state === "approved"
                ? "Permission granted"
                : tool.state === "running"
                  ? "Running"
                  : tool.state === "denied"
                    ? "Denied"
                    : tool.state === "error"
                      ? "Failed"
                      : tool.cached
                        ? "Completed · cache hit"
                        : "Completed"}
          </span>
        </span>
        <span className={`chevron${expanded ? " chevron--open" : ""}`} aria-hidden="true">
          ›
        </span>
      </button>

      {expanded && (
        <div className="tool-card__body">
          {tool.args !== undefined && (
            <div className="tool-card__block">
              <span className="tool-card__label">Input</span>
              <pre>{displayValue(tool.args)}</pre>
            </div>
          )}

          {showOutput && (
            <div className="tool-card__block">
              <span className="tool-card__label">Output</span>
              <pre>{displayValue(tool.output)}</pre>
            </div>
          )}

          {isPendingApproval && (
            <div className="approval-row">
              <div>
                <strong>Allow this action?</strong>
                <span>
                  {tool.reason || "Krater Pro will continue as soon as you decide."}
                </span>
              </div>
              <div className="approval-row__actions">
                <button
                  className="button button--ghost"
                  type="button"
                  disabled={disabled}
                  onClick={() => onApproval(tool, false)}
                >
                  Deny
                </button>
                <button
                  className="button button--accent"
                  type="button"
                  disabled={disabled}
                  onClick={() => onApproval(tool, true)}
                >
                  Allow
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function MessageView({
  message,
  approvalPending,
  onApproval,
}: {
  message: ChatMessage;
  approvalPending: string | null;
  onApproval: (tool: ToolActivity, approved: boolean) => void;
}) {
  if (message.role === "user") {
    return (
      <article className="message message--user">
        <div className="avatar avatar--user" aria-hidden="true">
          Y
        </div>
        <div className="message__content">
          <div className="message__author">You</div>
          <p>{message.content}</p>
        </div>
      </article>
    );
  }

  return (
    <article className="message message--assistant">
      <KraterMark small />
      <div className="message__content">
        <div className="message__author">
          Krater Pro
          {message.streaming && <span className="thinking-label">working</span>}
        </div>

        {message.content && <div className="assistant-text">{message.content}</div>}

        {message.tools?.map((tool) => (
          <ToolCard
            key={tool.id}
            tool={tool}
            disabled={approvalPending === tool.approvalId}
            onApproval={onApproval}
          />
        ))}

        {message.streaming && !message.content && !message.tools?.length && (
          <div className="thinking-dots" aria-label="Krater Pro is thinking">
            <span />
            <span />
            <span />
          </div>
        )}

        {message.usage && !message.streaming && (
          <div className="usage-note">{formatUsage(message.usage)}</div>
        )}
      </div>
    </article>
  );
}

export default function App() {
  const [status, setStatus] = useState<ApiStatus | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentProjectId, setCurrentProjectId] = useState("");
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectSourceDialog, setProjectSourceDialog] =
    useState<ProjectSourceDialog>(null);
  const [projectSource, setProjectSource] = useState("");
  const [models, setModels] = useState<Model[]>([]);
  const [selectedModel, setSelectedModel] = useState(initialModel);
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [offline, setOffline] = useState(false);
  const [credentialValidated, setCredentialValidated] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [chatTitle, setChatTitle] = useState("New task");
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [approvalPending, setApprovalPending] = useState<string | null>(null);
  const [error, setError] = useState("");

  const composerRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;

    async function loadWorkspace() {
      try {
        const [statusResponse, projectsResponse] = await Promise.all([
          fetch("/api/status"),
          fetch("/api/projects"),
        ]);
        if (!statusResponse.ok) {
          throw new Error(
            await responseError(statusResponse, "Workspace status unavailable."),
          );
        }
        if (!projectsResponse.ok) {
          throw new Error(
            await responseError(projectsResponse, "Project list unavailable."),
          );
        }
        const [nextStatus, nextProjects] = (await Promise.all([
          statusResponse.json(),
          projectsResponse.json(),
        ])) as [ApiStatus, ProjectsPayload];
        if (!active) return;
        setStatus(nextStatus);
        setProjects(nextProjects.projects);
        setCurrentProjectId(nextProjects.currentId);
        setOffline(false);
        setSelectedModel((current) => current || nextStatus.model);
      } catch (statusError) {
        if (!active) return;
        setOffline(true);
        setError(
          statusError instanceof Error
            ? statusError.message
            : "Workspace status unavailable.",
        );
      }
    }

    void loadWorkspace();
    return () => {
      active = false;
      abortRef.current?.abort();
      const activeSession = sessionIdRef.current;
      sessionIdRef.current = null;
      if (activeSession) void deleteSession(activeSession);
    };
  }, []);

  useEffect(() => {
    const key = apiKey.trim();
    if (!key && !status?.configured) {
      setCredentialValidated(false);
      setModels([]);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setCredentialValidated(false);
      try {
        const response = await fetch("/api/models", {
          ...(key ? { headers: { "x-krater-api-key": key } } : {}),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(
            await responseError(response, `Model discovery failed (${response.status}).`),
          );
        }

        const data = (await response.json()) as { models: Model[] };
        const availableModels = data.models ?? [];
        setModels(availableModels);
        setCredentialValidated(true);
        setError("");
        setSelectedModel((current) =>
          current && availableModels.some((model) => model.id === current)
            ? current
            : availableModels[0]?.id ?? current,
        );
      } catch (modelError) {
        if (modelError instanceof DOMException && modelError.name === "AbortError") return;
        setCredentialValidated(false);
        setError(
          modelError instanceof Error
            ? modelError.message
            : "Krater model discovery failed.",
        );
      }
    }, key ? 450 : 0);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [apiKey, status?.configured]);

  useEffect(() => {
    if (!selectedModel) return;
    try {
      window.localStorage.setItem(MODEL_STORAGE_KEY, selectedModel);
    } catch {
      // Model persistence is a convenience; the workspace still works without it.
    }
  }, [selectedModel]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: streaming ? "auto" : "smooth", block: "end" });
  }, [messages, streaming]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        setSettingsOpen(true);
      }

      if (event.key === "Escape") {
        setSettingsOpen(false);
        setSidebarOpen(false);
        setProjectSourceDialog(null);
        setProjectSource("");
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const connectionLabel = statusText(
    status,
    apiKey,
    offline,
    credentialValidated,
  );
  const isReady = Boolean(apiKey.trim() || status?.configured);
  const currentProject = useMemo(
    () => projects.find((project) => project.id === currentProjectId) ?? null,
    [currentProjectId, projects],
  );
  const modelOptions = useMemo(() => {
    if (!selectedModel || models.some((model) => model.id === selectedModel)) return models;
    return [{ id: selectedModel }, ...models];
  }, [models, selectedModel]);

  const patchAssistant = useCallback(
    (assistantId: string, patcher: (message: ChatMessage) => ChatMessage) => {
      setMessages((current) =>
        current.map((message) => (message.id === assistantId ? patcher(message) : message)),
      );
    },
    [],
  );

  const handleStreamEvent = useCallback(
    (assistantId: string, event: StreamEvent) => {
      if (event.type === "text") {
        patchAssistant(assistantId, (message) => ({
          ...message,
          content: message.content + event.text,
        }));
        return;
      }

      if (event.type === "tool") {
        patchAssistant(assistantId, (message) => ({
          ...message,
          tools: upsertTool(message.tools, {
            id: event.id,
            name: event.name,
            args: event.args,
            state: "running",
          }),
        }));
        return;
      }

      if (event.type === "approval") {
        patchAssistant(assistantId, (message) => ({
          ...message,
          tools: upsertTool(message.tools, {
            id: event.toolCallId ?? event.id,
            name: event.tool,
            args: event.args,
            approvalId: event.id,
            reason: event.reason,
            state: "approval",
          }),
        }));
        return;
      }

      if (event.type === "tool_result") {
        patchAssistant(assistantId, (message) => ({
          ...message,
          tools: upsertTool(message.tools, {
            id: event.id,
            name: event.name,
            output: event.output,
            ok: event.ok,
            cached: event.cached,
            state: event.ok
              ? "success"
              : typeof event.output === "string" &&
                  event.output.startsWith("User denied")
                ? "denied"
                : "error",
          }),
        }));
        return;
      }

      if (event.type === "usage") {
        const { type: _type, ...usage } = event;
        patchAssistant(assistantId, (message) => ({ ...message, usage }));
        return;
      }

      if (event.type === "done") {
        patchAssistant(assistantId, (message) => ({ ...message, streaming: false }));
        return;
      }

      if (event.type === "error") {
        patchAssistant(assistantId, (message) => ({
          ...message,
          content: message.content || event.message,
          streaming: false,
        }));
        setError(event.message);
      }
    },
    [patchAssistant],
  );

  const consumeEventStream = useCallback(
    async (response: Response, assistantId: string) => {
      await consumeSseEvents(response, (event) =>
        handleStreamEvent(assistantId, event),
      );
    },
    [handleStreamEvent],
  );

  const ensureSession = useCallback(async () => {
    if (sessionIdRef.current) return sessionIdRef.current;

    const response = await fetch("/api/sessions", { method: "POST" });
    if (!response.ok) throw new Error("Could not start a Krater Pro session.");
    const data = (await response.json()) as { id: string };
    if (!data.id) throw new Error("The server did not return a session ID.");
    sessionIdRef.current = data.id;
    setSessionId(data.id);
    return data.id;
  }, []);

  const sendMessage = useCallback(
    async (rawMessage: string) => {
      const message = rawMessage.trim();
      if (!message || streaming) return;

      setDraft("");
      setError("");
      setStreaming(true);
      setChatTitle((current) => (current === "New task" ? titleFromMessage(message) : current));

      const userMessage: ChatMessage = {
        id: createId("user"),
        role: "user",
        content: message,
      };
      const assistantId = createId("assistant");
      const assistantMessage: ChatMessage = {
        id: assistantId,
        role: "assistant",
        content: "",
        tools: [],
        streaming: true,
      };

      setMessages((current) => [...current, userMessage, assistantMessage]);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const activeSessionId = await ensureSession();
        const response = await fetch(`/api/sessions/${encodeURIComponent(activeSessionId)}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message,
            model: selectedModel || undefined,
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(
            await responseError(
              response,
              `Krater request failed (${response.status}).`,
            ),
          );
        }

        await consumeEventStream(response, assistantId);
      } catch (requestError) {
        if (requestError instanceof DOMException && requestError.name === "AbortError") return;
        const messageText =
          requestError instanceof Error ? requestError.message : "Something went wrong.";
        setError(messageText);
        patchAssistant(assistantId, (assistantMessage) => ({
          ...assistantMessage,
          content: assistantMessage.content || messageText,
          streaming: false,
        }));
      } finally {
        setStreaming(false);
        abortRef.current = null;
        patchAssistant(assistantId, (assistantMessage) => ({
          ...assistantMessage,
          streaming: false,
        }));
        window.setTimeout(() => composerRef.current?.focus(), 0);
      }
    },
    [
      apiKey,
      consumeEventStream,
      ensureSession,
      patchAssistant,
      selectedModel,
      streaming,
    ],
  );

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void sendMessage(draft);
  };

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void sendMessage(draft);
    }
  };

  const resizeComposer = (value: string) => {
    setDraft(value);
    const field = composerRef.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight, 180)}px`;
  };

  const newTask = () => {
    abortRef.current?.abort();
    const previousSession = sessionIdRef.current;
    sessionIdRef.current = null;
    if (previousSession) void deleteSession(previousSession);
    setMessages([]);
    setSessionId(null);
    setChatTitle("New task");
    setStreaming(false);
    setError("");
    setSidebarOpen(false);
    window.setTimeout(() => composerRef.current?.focus(), 0);
  };

  const canChangeProject = () => {
    if (streaming) {
      setError("Stop the current response before changing projects.");
      return false;
    }
    if (projectBusy) return false;
    if (
      (messages.length > 0 || sessionIdRef.current) &&
      !window.confirm(
        "Switching projects starts a new task and clears this conversation. Continue?",
      )
    ) {
      return false;
    }
    return true;
  };

  const changeProject = async (
    endpoint: "select" | "local" | "scratch" | "github",
    body: Record<string, string> = {},
  ) => {
    if (!canChangeProject()) return;
    setProjectBusy(true);
    setError("");

    try {
      const response = await fetch(`/api/projects/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(
          await responseError(response, `Could not change projects (${response.status}).`),
        );
      }

      const payload = (await response.json()) as ProjectsPayload;
      newTask();
      setProjects(payload.projects);
      setCurrentProjectId(payload.currentId);
      setStatus((current) =>
        current
          ? {
              ...current,
              cwd: payload.current.path,
              projectId: payload.current.id,
              projectKind: payload.current.kind,
            }
          : current,
      );
      setProjectSourceDialog(null);
      setProjectSource("");
      setOffline(false);
    } catch (projectError) {
      setError(
        projectError instanceof Error
          ? projectError.message
          : "The project could not be changed.",
      );
    } finally {
      setProjectBusy(false);
    }
  };

  const chooseProject = (value: string) => {
    if (!value || value === currentProjectId) return;
    if (value === ADD_LOCAL_PROJECT || value === ADD_GITHUB_PROJECT) {
      if (streaming) {
        setError("Stop the current response before changing projects.");
        return;
      }
      setProjectSource("");
      setProjectSourceDialog(
        value === ADD_LOCAL_PROJECT ? "local" : "github",
      );
      return;
    }
    if (value === ADD_SCRATCH_PROJECT) {
      void changeProject("scratch", { name: "scratch" });
      return;
    }
    void changeProject("select", { id: value });
  };

  const submitProjectSource = (event: FormEvent) => {
    event.preventDefault();
    const source = projectSource.trim();
    if (!source || !projectSourceDialog) return;
    void changeProject(
      projectSourceDialog,
      projectSourceDialog === "local" ? { path: source } : { url: source },
    );
  };

  const changeModel = (nextModel: string) => {
    if (nextModel === selectedModel) return;
    if (streaming) {
      setError("Stop the current response before changing models.");
      return;
    }
    if (
      messages.length > 0 &&
      !window.confirm("Changing models starts a new task and clears this conversation. Continue?")
    ) {
      return;
    }
    if (sessionIdRef.current || messages.length > 0) newTask();
    setSelectedModel(nextModel);
  };

  const changeApiKey = (nextKey: string) => {
    if (nextKey === apiKey) return;
    if (streaming) {
      setError("Stop the current response before changing the API key.");
      return;
    }
    if (
      messages.length > 0 &&
      !window.confirm("Changing the API key starts a new task and clears this conversation. Continue?")
    ) {
      return;
    }
    if (sessionIdRef.current || messages.length > 0) newTask();
    setApiKey(nextKey);
  };

  const respondToApproval = async (tool: ToolActivity, approved: boolean) => {
    if (!sessionId || !tool.approvalId) return;
    setApprovalPending(tool.approvalId);
    setError("");

    try {
      const response = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(tool.approvalId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ approved }),
        },
      );

      if (!response.ok) throw new Error("The approval decision could not be sent.");

      setMessages((current) =>
        current.map((message) => ({
          ...message,
          tools: message.tools?.map((activity) =>
            activity.approvalId === tool.approvalId && activity.state === "approval"
              ? {
                  ...activity,
                  state: approved ? ("approved" as const) : ("denied" as const),
                }
              : activity,
          ),
        })),
      );
    } catch (approvalError) {
      setError(
        approvalError instanceof Error ? approvalError.message : "Could not send your decision.",
      );
    } finally {
      setApprovalPending(null);
    }
  };

  return (
    <div className="app-shell">
      <aside className={`sidebar${sidebarOpen ? " sidebar--open" : ""}`}>
        <div className="sidebar__brand">
          <KraterMark />
          <div>
            <strong>Krater Pro</strong>
            <span>AI engineering workspace</span>
          </div>
          <button
            className="icon-button sidebar__close"
            type="button"
            aria-label="Close sidebar"
            onClick={() => setSidebarOpen(false)}
          >
            ×
          </button>
        </div>

        <button className="new-task-button" type="button" onClick={newTask}>
          <span aria-hidden="true">＋</span>
          New task
          <kbd>⌘ N</kbd>
        </button>

        <nav className="history" aria-label="Task history">
          <div className="history__label">Today</div>
          <button
            className={`history__item${messages.length ? " history__item--active" : ""}`}
            type="button"
            onClick={() => setSidebarOpen(false)}
          >
            <span className="history__icon" aria-hidden="true">
              ◫
            </span>
            <span>{chatTitle}</span>
            {messages.length > 0 && <i aria-label="Active task" />}
          </button>
        </nav>

        <div className="sidebar__spacer" />

        <div className="workspace-card">
          <span className="workspace-card__icon" aria-hidden="true">
            ⌘
          </span>
          <div>
            <span>
              {currentProject ? `${projectKindLabel(currentProject.kind)} workspace` : "Workspace"}
            </span>
            <strong title={currentProject?.path ?? status?.cwd}>
              {currentProject?.name ??
                status?.cwd?.split("/").filter(Boolean).pop() ??
                "Local"}
            </strong>
          </div>
        </div>

        <button className="settings-button" type="button" onClick={() => setSettingsOpen(true)}>
          <span aria-hidden="true">⚙</span>
          Settings
          <kbd>⌘ ,</kbd>
        </button>

        <div className="sidebar__meta">
          <span className="sidebar__credit">
            Built by{" "}
            <a
              href="https://www.linkedin.com/in/supratimsircar/"
              target="_blank"
              rel="noreferrer"
            >
              Supratim
            </a>{" "}
            with ❤️
          </span>
          <span>v{status?.version ?? "0.1.0"}</span>
        </div>
      </aside>

      {sidebarOpen && (
        <button
          className="sidebar-scrim"
          type="button"
          aria-label="Close sidebar"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <main className="main-panel">
        <header className="topbar">
          <button
            className="icon-button menu-button"
            type="button"
            aria-label="Open sidebar"
            onClick={() => setSidebarOpen(true)}
          >
            ☰
          </button>
          <span className="topbar__brand-mark">
            <KraterMark small />
          </span>
          <div className="topbar__title">
            <span>{chatTitle}</span>
            <small>{status?.cwd ?? "Local workspace"}</small>
          </div>

          <div className="topbar__actions">
            <label className="project-picker">
              <span className="project-picker__icon" aria-hidden="true">
                ◫
              </span>
              <select
                value={currentProjectId}
                onChange={(event) => chooseProject(event.target.value)}
                aria-label="Project workspace"
                aria-busy={projectBusy}
                disabled={streaming || projectBusy}
              >
                {!projects.length && <option value="">Loading project…</option>}
                <optgroup label="Projects">
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name} · {projectKindLabel(project.kind)}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Add workspace">
                  <option value={ADD_LOCAL_PROJECT}>Open local folder…</option>
                  <option value={ADD_GITHUB_PROJECT}>Clone GitHub repository…</option>
                  <option value={ADD_SCRATCH_PROJECT}>New scratch workspace</option>
                </optgroup>
              </select>
              <span className="project-picker__chevron" aria-hidden="true">
                {projectBusy ? "…" : "▾"}
              </span>
            </label>

            <label className="model-picker">
              <span className="model-picker__spark" aria-hidden="true">
                ✦
              </span>
              <select
                value={selectedModel}
                onChange={(event) => changeModel(event.target.value)}
                aria-label="Model"
                disabled={streaming}
              >
                {!modelOptions.length && <option value="">Default model</option>}
                {modelOptions.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.id}
                  </option>
                ))}
              </select>
              <span className="model-picker__chevron" aria-hidden="true">
                ▾
              </span>
            </label>

            <button
              className={`connection-pill${offline ? " connection-pill--offline" : ""}${
                isReady ? " connection-pill--ready" : ""
              }`}
              type="button"
              aria-label={connectionLabel}
              onClick={() => setSettingsOpen(true)}
            >
              <i />
              <span>{connectionLabel}</span>
            </button>
          </div>
        </header>

        <div className={`conversation${messages.length ? "" : " conversation--empty"}`}>
          {!messages.length ? (
            <div className="welcome">
              <div className="welcome__graphic" aria-hidden="true">
                <span className="welcome__orbit welcome__orbit--one" />
                <span className="welcome__orbit welcome__orbit--two" />
                <KraterMark />
              </div>
              <div className="eyebrow">Powered by Krater AI</div>
              <h1>What are we building?</h1>
              <p>
                Ask Krater Pro to understand your code, make changes, run tools, and help
                carry the work all the way through.
              </p>

              <div className="starter-grid">
                {starterPrompts.map((prompt) => (
                  <button
                    key={prompt.label}
                    className="starter-card"
                    type="button"
                    onClick={() => {
                      setDraft(prompt.detail);
                      window.setTimeout(() => composerRef.current?.focus(), 0);
                    }}
                  >
                    <span className="starter-card__icon" aria-hidden="true">
                      {prompt.icon}
                    </span>
                    <span>
                      <strong>{prompt.label}</strong>
                      <small>{prompt.detail}</small>
                    </span>
                    <i aria-hidden="true">↗</i>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="messages">
              {messages.map((message) => (
                <MessageView
                  key={message.id}
                  message={message}
                  approvalPending={approvalPending}
                  onApproval={respondToApproval}
                />
              ))}
              <div ref={endRef} />
            </div>
          )}
        </div>

        <div className="composer-region">
          {error && (
            <div className="error-banner" role="alert">
              <span aria-hidden="true">!</span>
              <p>{error}</p>
              <button type="button" aria-label="Dismiss error" onClick={() => setError("")}>
                ×
              </button>
            </div>
          )}

          {!isReady && !offline && (
            <button className="key-notice" type="button" onClick={() => setSettingsOpen(true)}>
              <span aria-hidden="true">⌁</span>
              Add a Krater API key to start a task
              <i aria-hidden="true">→</i>
            </button>
          )}

          <form className="composer" onSubmit={onSubmit}>
            <textarea
              ref={composerRef}
              value={draft}
              onChange={(event) => resizeComposer(event.target.value)}
              onKeyDown={onComposerKeyDown}
              placeholder="Ask Krater Pro to build, explain, or fix something…"
              rows={1}
              aria-label="Message Krater Pro"
            />
            <div className="composer__footer">
              <div className="composer__hint">
                <span>Enter to send</span>
                <span>Shift + Enter for new line</span>
              </div>
              <button
                className="send-button"
                type="submit"
                disabled={!draft.trim() || streaming}
                aria-label={streaming ? "Krater Pro is working" : "Send message"}
              >
                {streaming ? <span className="send-button__spinner" /> : "↑"}
              </button>
            </div>
          </form>
          <p className="composer-region__note">
            Krater Pro may make mistakes. Review code changes and tool actions.
          </p>
        </div>
      </main>

      {settingsOpen && (
        <div className="modal-layer" role="presentation">
          <button
            className="modal-layer__backdrop"
            type="button"
            aria-label="Close settings"
            onClick={() => setSettingsOpen(false)}
          />
          <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <div className="settings-modal__header">
              <div>
                <span className="eyebrow">Workspace preferences</span>
                <h2 id="settings-title">Settings</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="Close settings"
                onClick={() => setSettingsOpen(false)}
              >
                ×
              </button>
            </div>

            <div className="settings-section">
              <div className="settings-section__intro">
                <div>
                  <h3>Project workspace</h3>
                  <p>Switch codebases without restarting Krater Pro.</p>
                </div>
                {currentProject && (
                  <span className="settings-status settings-status--ready">
                    {projectKindLabel(currentProject.kind)}
                  </span>
                )}
              </div>
              <div className="project-summary">
                <span>{currentProject?.name ?? "Loading workspace"}</span>
                <code title={currentProject?.path ?? status?.cwd}>
                  {currentProject?.path ?? status?.cwd ?? "Local workspace"}
                </code>
                {currentProject?.source && <small>{currentProject.source}</small>}
              </div>
              <div className="project-actions">
                <button
                  className="button button--ghost"
                  type="button"
                  disabled={streaming || projectBusy}
                  onClick={() => {
                    setSettingsOpen(false);
                    setProjectSource("");
                    setProjectSourceDialog("local");
                  }}
                >
                  Local folder
                </button>
                <button
                  className="button button--ghost"
                  type="button"
                  disabled={streaming || projectBusy}
                  onClick={() => {
                    setSettingsOpen(false);
                    setProjectSource("");
                    setProjectSourceDialog("github");
                  }}
                >
                  GitHub repo
                </button>
                <button
                  className="button button--ghost"
                  type="button"
                  disabled={streaming || projectBusy}
                  onClick={() => void changeProject("scratch", { name: "scratch" })}
                >
                  Scratch
                </button>
              </div>
            </div>

            <div className="settings-section">
              <div className="settings-section__intro">
                <div>
                  <h3>Krater API key</h3>
                  <p>Use a key for this browser tab instead of the server environment.</p>
                </div>
                <span
                  className={`settings-status${isReady ? " settings-status--ready" : ""}`}
                >
                  {credentialValidated
                    ? "Krater validated"
                    : apiKey.trim()
                      ? "Tab key (unverified)"
                      : status?.configured
                        ? "Environment key (unverified)"
                        : "Not configured"}
                </span>
              </div>

              <label className="field-label" htmlFor="api-key">
                API key
              </label>
              <div className="secret-field">
                <input
                  id="api-key"
                  type={showApiKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(event) => changeApiKey(event.target.value)}
                  placeholder={status?.configured ? "Using server environment key" : "kr_live_…"}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={streaming}
                />
                <button type="button" onClick={() => setShowApiKey((value) => !value)}>
                  {showApiKey ? "Hide" : "Show"}
                </button>
              </div>
              <p className="privacy-note">
                <span aria-hidden="true">⌁</span>
                Kept only in memory and cleared when this tab closes. It is never saved to
                browser storage.
              </p>
              <a
                className="browser-auth-link"
                href="https://krater.ai/developers"
                target="_blank"
                rel="noreferrer"
              >
                Open Krater account &amp; API setup ↗
              </a>
              <p className="privacy-note">
                Krater does not currently publish third-party OAuth. Krater Pro never
                reads browser cookies or extracts session tokens.
              </p>
            </div>

            <div className="settings-section">
              <div className="settings-section__intro">
                <div>
                  <h3>Default model</h3>
                  <p>Choose which Krater model handles new messages.</p>
                </div>
              </div>
              <label className="field-label" htmlFor="settings-model">
                Model
              </label>
              <div className="select-field">
                <select
                  id="settings-model"
                  value={selectedModel}
                  onChange={(event) => changeModel(event.target.value)}
                  disabled={streaming}
                >
                  {!modelOptions.length && <option value="">Server default</option>}
                  {modelOptions.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.id}
                    </option>
                  ))}
                </select>
                <span aria-hidden="true">▾</span>
              </div>
            </div>

            <div className="settings-modal__footer">
              <div className="settings-connection">
                <i className={offline ? "is-offline" : isReady ? "is-ready" : ""} />
                <span>{connectionLabel}</span>
              </div>
              <button
                className="button button--accent"
                type="button"
                onClick={() => {
                  setSettingsOpen(false);
                  window.setTimeout(() => composerRef.current?.focus(), 0);
                }}
              >
                Done
              </button>
            </div>
          </section>
        </div>
      )}

      {projectSourceDialog && (
        <div className="modal-layer" role="presentation">
          <button
            className="modal-layer__backdrop"
            type="button"
            aria-label="Close project dialog"
            disabled={projectBusy}
            onClick={() => {
              setProjectSourceDialog(null);
              setProjectSource("");
            }}
          />
          <section
            className="settings-modal project-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="project-dialog-title"
          >
            <div className="settings-modal__header">
              <div>
                <span className="eyebrow">
                  {projectSourceDialog === "local" ? "Local workspace" : "Public repository"}
                </span>
                <h2 id="project-dialog-title">
                  {projectSourceDialog === "local"
                    ? "Open a project folder"
                    : "Clone from GitHub"}
                </h2>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="Close project dialog"
                disabled={projectBusy}
                onClick={() => {
                  setProjectSourceDialog(null);
                  setProjectSource("");
                }}
              >
                ×
              </button>
            </div>
            <form onSubmit={submitProjectSource}>
              <div className="settings-section project-modal__body">
                <label className="field-label" htmlFor="project-source">
                  {projectSourceDialog === "local"
                    ? "Absolute folder path"
                    : "GitHub repository URL"}
                </label>
                <div className="secret-field project-source-field">
                  <input
                    id="project-source"
                    type="text"
                    value={projectSource}
                    onChange={(event) => setProjectSource(event.target.value)}
                    placeholder={
                      projectSourceDialog === "local"
                        ? "/Users/you/Projects/my-app"
                        : "https://github.com/owner/repository"
                    }
                    autoComplete="off"
                    spellCheck={false}
                    disabled={projectBusy}
                    autoFocus
                  />
                </div>
                <p className="privacy-note">
                  <span aria-hidden="true">⌁</span>
                  {projectSourceDialog === "local"
                    ? "The folder must already exist on this computer. Krater Pro stays inside the selected workspace."
                    : "Krater Pro accepts public GitHub HTTPS URLs and creates an isolated shallow clone."}
                </p>
              </div>
              <div className="settings-modal__footer">
                <span className="project-dialog-note">
                  Switching starts a clean task.
                </span>
                <button
                  className="button button--ghost"
                  type="button"
                  disabled={projectBusy}
                  onClick={() => {
                    setProjectSourceDialog(null);
                    setProjectSource("");
                  }}
                >
                  Cancel
                </button>
                <button
                  className="button button--accent"
                  type="submit"
                  disabled={!projectSource.trim() || projectBusy}
                >
                  {projectBusy
                    ? projectSourceDialog === "github"
                      ? "Cloning…"
                      : "Opening…"
                    : projectSourceDialog === "github"
                      ? "Clone repository"
                      : "Open folder"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}

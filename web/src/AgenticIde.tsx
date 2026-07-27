import {
  FormEvent,
  KeyboardEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { apiFetch } from "./api";

type TreeEntry = {
  path: string;
  name: string;
  type: "file" | "directory";
  depth?: number;
  size?: number;
  modifiedAt?: string;
  ignored?: boolean;
};

type TreePayload = {
  projectId: string;
  root: string;
  entries: TreeEntry[];
  truncated?: boolean;
};

type FilePayload = {
  projectId: string;
  path: string;
  content: string;
  size: number;
  modifiedAt: string;
  revision: string;
  saved?: boolean;
};

type EditorTab = FilePayload & {
  savedContent: string;
  loading?: boolean;
};

type TerminalResult = {
  projectId: string;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
};

type TerminalPayload = Omit<TerminalResult, "command">;

type TerminalEntry = TerminalResult & {
  id: string;
  running?: boolean;
};

type GitStatusEntry = {
  index: string;
  workingTree: string;
  path: string;
  originalPath?: string;
};

type BottomPanel = "terminal" | "git";

type AgenticIdeProps = {
  projectId: string;
  projectName: string;
  projectPath: string;
  active: boolean;
  assistant: ReactNode;
  agentBusy: boolean;
  onAskKrater: (prompt: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
};

const MAX_TERMINAL_ENTRIES = 40;
const MAX_TERMINAL_OUTPUT = 48_000;
const MAX_AGENT_CONTEXT = 6_000;

async function apiError(response: Response, fallback: string) {
  const raw = (await response.text()).trim();
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as {
      error?: { message?: unknown };
      message?: unknown;
    };
    if (typeof parsed.error?.message === "string") return parsed.error.message;
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // Plain-text API failures are safe to display.
  }
  return raw;
}

function boundedOutput(value: string) {
  if (value.length <= MAX_TERMINAL_OUTPUT) return value;
  const omitted = value.length - MAX_TERMINAL_OUTPUT;
  return `… ${omitted.toLocaleString()} earlier characters omitted …\n${value.slice(
    -MAX_TERMINAL_OUTPUT,
  )}`;
}

function extension(path: string) {
  const name = path.split("/").pop() ?? path;
  if (!name.includes(".")) return "";
  return name.split(".").pop()?.toLowerCase() ?? "";
}

function languageFor(path: string) {
  const ext = extension(path);
  const languages: Record<string, string> = {
    c: "C",
    cc: "C++",
    cpp: "C++",
    css: "CSS",
    go: "Go",
    html: "HTML",
    java: "Java",
    js: "JavaScript",
    json: "JSON",
    jsx: "JavaScript React",
    kt: "Kotlin",
    md: "Markdown",
    php: "PHP",
    py: "Python",
    rb: "Ruby",
    rs: "Rust",
    sh: "Shell",
    sql: "SQL",
    swift: "Swift",
    toml: "TOML",
    ts: "TypeScript",
    tsx: "TypeScript React",
    vue: "Vue",
    xml: "XML",
    yaml: "YAML",
    yml: "YAML",
  };
  return languages[ext] ?? (ext ? ext.toUpperCase() : "Plain text");
}

function fileGlyph(entry: TreeEntry) {
  if (entry.type === "directory") return "›";
  const ext = extension(entry.path);
  if (["ts", "tsx", "js", "jsx"].includes(ext)) return "TS";
  if (ext === "py") return "Py";
  if (ext === "rs") return "Rs";
  if (ext === "go") return "Go";
  if (["json", "yaml", "yml", "toml"].includes(ext)) return "{}";
  if (["md", "txt"].includes(ext)) return "¶";
  if (["css", "scss"].includes(ext)) return "#";
  return "·";
}

function lineAndColumn(content: string, offset: number) {
  const before = content.slice(0, Math.max(0, offset));
  const rows = before.split("\n");
  return { line: rows.length, column: (rows.at(-1)?.length ?? 0) + 1 };
}

function diffClass(line: string) {
  if (line.startsWith("+") && !line.startsWith("+++")) return "is-addition";
  if (line.startsWith("-") && !line.startsWith("---")) return "is-deletion";
  if (line.startsWith("@@")) return "is-hunk";
  if (line.startsWith("diff ") || line.startsWith("index ")) return "is-heading";
  return "";
}

function terminalStatus(entry: TerminalEntry) {
  if (entry.running) return "running";
  if (entry.timedOut) return "timed out";
  if (entry.exitCode === 0) return `${entry.durationMs} ms`;
  return `exit ${entry.exitCode ?? "?"}`;
}

export default function AgenticIde({
  projectId,
  projectName,
  projectPath,
  active,
  assistant,
  agentBusy,
  onAskKrater,
  onDirtyChange,
}: AgenticIdeProps) {
  const [tree, setTree] = useState<TreeEntry[]>([]);
  const [treeRoot, setTreeRoot] = useState(projectPath);
  const [treeLoading, setTreeLoading] = useState(true);
  const [treeTruncated, setTreeTruncated] = useState(false);
  const [treeFilter, setTreeFilter] = useState("");
  const [collapsedDirectories, setCollapsedDirectories] = useState<Set<string>>(
    new Set(),
  );
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [agentOpen, setAgentOpen] = useState(true);
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activePath, setActivePath] = useState("");
  const [savingPath, setSavingPath] = useState("");
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [ideError, setIdeError] = useState("");
  const [bottomOpen, setBottomOpen] = useState(true);
  const [bottomPanel, setBottomPanel] = useState<BottomPanel>("terminal");
  const [terminalCommand, setTerminalCommand] = useState("");
  const [terminalTimeout, setTerminalTimeout] = useState(15_000);
  const [terminalEntries, setTerminalEntries] = useState<TerminalEntry[]>([]);
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [terminalBusy, setTerminalBusy] = useState(false);
  const [gitStatus, setGitStatus] = useState("");
  const [gitBranch, setGitBranch] = useState("");
  const [gitEntries, setGitEntries] = useState<GitStatusEntry[]>([]);
  const [gitDiff, setGitDiff] = useState("");
  const [gitError, setGitError] = useState("");
  const [gitStaged, setGitStaged] = useState(false);
  const [gitLoading, setGitLoading] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);

  const editorRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLPreElement>(null);
  const treeFilterRef = useRef<HTMLInputElement>(null);
  const terminalInputRef = useRef<HTMLInputElement>(null);
  const bottomOutputRef = useRef<HTMLDivElement>(null);
  const agentWasBusyRef = useRef(agentBusy);
  const currentProjectIdRef = useRef(projectId);
  const treeLoadIdRef = useRef(0);
  const gitLoadIdRef = useRef(0);
  const openingPathsRef = useRef(new Set<string>());
  currentProjectIdRef.current = projectId;

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.path === activePath) ?? null,
    [activePath, tabs],
  );
  const isDirty = Boolean(
    activeTab && activeTab.content !== activeTab.savedContent,
  );
  const hasDirtyTabs = useMemo(
    () => tabs.some((tab) => tab.content !== tab.savedContent),
    [tabs],
  );
  const cursor = useMemo(
    () => lineAndColumn(activeTab?.content ?? "", selection.end),
    [activeTab?.content, selection.end],
  );
  const statusLines = useMemo(
    () =>
      gitEntries.map(
        (entry) =>
          `${entry.index}${entry.workingTree} ${entry.originalPath ? `${entry.originalPath} -> ` : ""}${entry.path}`,
      ),
    [gitEntries],
  );

  useEffect(() => {
    onDirtyChange?.(hasDirtyTabs);
    return () => onDirtyChange?.(false);
  }, [hasDirtyTabs, onDirtyChange]);

  useEffect(() => {
    if (!hasDirtyTabs) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [hasDirtyTabs]);

  const loadTree = useCallback(async (collapseFolders = false) => {
    const loadId = ++treeLoadIdRef.current;
    setTreeLoading(true);
    setIdeError("");
    try {
      const response = await apiFetch(
        `/api/ide/tree?path=.&depth=6&projectId=${encodeURIComponent(projectId)}`,
      );
      if (!response.ok) {
        throw new Error(
          await apiError(
            response,
            "Could not load this project. Confirm the workspace is still available.",
          ),
        );
      }
      const payload = (await response.json()) as TreePayload;
      if (payload.projectId !== currentProjectIdRef.current) return;
      if (loadId !== treeLoadIdRef.current) return;
      setTree(payload.entries ?? []);
      setTreeRoot(payload.root || projectPath);
      setTreeTruncated(Boolean(payload.truncated));
      if (collapseFolders) {
        setCollapsedDirectories(
          new Set(
            (payload.entries ?? [])
              .filter((entry) => entry.type === "directory")
              .map((entry) => entry.path),
          ),
        );
      }
    } catch (error) {
      if (loadId !== treeLoadIdRef.current) return;
      setIdeError(
        error instanceof Error
          ? error.message
          : "The file explorer could not be loaded.",
      );
      setTree([]);
    } finally {
      if (loadId === treeLoadIdRef.current) setTreeLoading(false);
    }
  }, [projectId, projectPath]);

  const refreshCleanTabs = useCallback(async () => {
    const cleanSnapshots = tabs
      .filter((tab) => !tab.loading && tab.content === tab.savedContent)
      .map((tab) => ({
        path: tab.path,
        revision: tab.revision,
        content: tab.content,
      }));
    if (!cleanSnapshots.length) return;

    const refreshed = await Promise.all(
      cleanSnapshots.map(async (snapshot) => {
        try {
          const response = await apiFetch(
            `/api/ide/file?path=${encodeURIComponent(snapshot.path)}&projectId=${encodeURIComponent(projectId)}`,
          );
          if (!response.ok) return null;
          const payload = (await response.json()) as FilePayload;
          return payload.projectId === currentProjectIdRef.current
            ? { payload, snapshot }
            : null;
        } catch {
          return null;
        }
      }),
    );
    const byPath = new Map(
      refreshed
        .filter(
          (
            file,
          ): file is {
            payload: FilePayload;
            snapshot: { path: string; revision: string; content: string };
          } => Boolean(file),
        )
        .map((file) => [file.payload.path, file]),
    );
    if (!byPath.size) return;
    setTabs((current) =>
      current.map((tab) => {
        const refreshedFile = byPath.get(tab.path);
        if (
          !refreshedFile ||
          tab.content !== tab.savedContent ||
          tab.revision !== refreshedFile.snapshot.revision ||
          tab.content !== refreshedFile.snapshot.content
        ) {
          return tab;
        }
        return {
          ...refreshedFile.payload,
          savedContent: refreshedFile.payload.content,
        };
      }),
    );
  }, [projectId, tabs]);

  const loadGit = useCallback(
    async (staged: boolean) => {
      const loadId = ++gitLoadIdRef.current;
      setGitLoading(true);
      setGitError("");
      try {
        const [statusResponse, diffResponse] = await Promise.all([
          apiFetch(
            `/api/ide/git/status?projectId=${encodeURIComponent(projectId)}`,
          ),
          apiFetch(
            `/api/ide/git/diff?staged=${staged ? "true" : "false"}&projectId=${encodeURIComponent(projectId)}`,
          ),
        ]);
        if (!statusResponse.ok) {
          throw new Error(
            await apiError(
              statusResponse,
              "Git status is unavailable. This workspace may not be a Git repository.",
            ),
          );
        }
        if (!diffResponse.ok) {
          throw new Error(
            await apiError(diffResponse, "The Git diff could not be loaded."),
          );
        }
        const statusPayload = (await statusResponse.json()) as {
          projectId: string;
          branch?: string;
          status: string;
          entries?: GitStatusEntry[];
        };
        const diffPayload = (await diffResponse.json()) as {
          projectId: string;
          diff: string;
        };
        if (
          statusPayload.projectId !== currentProjectIdRef.current ||
          diffPayload.projectId !== currentProjectIdRef.current
        ) {
          return;
        }
        if (loadId !== gitLoadIdRef.current) return;
        setGitStatus(statusPayload.status ?? "");
        setGitBranch(statusPayload.branch ?? "");
        setGitEntries(statusPayload.entries ?? []);
        setGitDiff(diffPayload.diff ?? "");
      } catch (error) {
        if (loadId !== gitLoadIdRef.current) return;
        setGitError(
          error instanceof Error ? error.message : "Git information is unavailable.",
        );
        setGitStatus("");
        setGitBranch("");
        setGitEntries([]);
        setGitDiff("");
      } finally {
        if (loadId === gitLoadIdRef.current) setGitLoading(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    treeLoadIdRef.current += 1;
    gitLoadIdRef.current += 1;
    openingPathsRef.current.clear();
    setTabs([]);
    setActivePath("");
    setTerminalEntries([]);
    setTerminalCommand("");
    setCommandHistory([]);
    setHistoryIndex(-1);
    setTreeFilter("");
    setSelection({ start: 0, end: 0 });
    setContextMenu(null);
    setIdeError("");
    setCollapsedDirectories(new Set());
    setGitStatus("");
    setGitBranch("");
    setGitEntries([]);
    setGitDiff("");
    setGitError("");
    setGitStaged(false);
    void loadTree(true);
    void loadGit(false);
  }, [projectId, loadGit, loadTree]);

  useEffect(() => {
    setSelection({ start: 0, end: 0 });
  }, [activePath]);

  useEffect(() => {
    const justFinished = agentWasBusyRef.current && !agentBusy;
    agentWasBusyRef.current = agentBusy;
    if (!justFinished) return;
    void loadTree();
    void loadGit(gitStaged);
    void refreshCleanTabs();
  }, [agentBusy, gitStaged, loadGit, loadTree, refreshCleanTabs]);

  useEffect(() => {
    const dismiss = () => setContextMenu(null);
    window.addEventListener("click", dismiss);
    return () => window.removeEventListener("click", dismiss);
  }, []);

  const saveActive = useCallback(async () => {
    if (!activeTab || activeTab.content === activeTab.savedContent || savingPath) {
      return;
    }
    setSavingPath(activeTab.path);
    setIdeError("");
    try {
      const response = await apiFetch("/api/ide/file", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          path: activeTab.path,
          content: activeTab.content,
          revision: activeTab.revision,
        }),
      });
      if (!response.ok) {
        const message = await apiError(
          response,
          "The file could not be saved. Reload it and try again.",
        );
        throw new Error(
          response.status === 409
            ? `${message} The file changed on disk; reload it before saving.`
            : message,
        );
      }
      const payload = (await response.json()) as FilePayload;
      if (payload.projectId !== currentProjectIdRef.current) return;
      setTabs((current) =>
        current.map((tab) =>
          tab.path === activeTab.path
            ? {
                ...tab,
                ...payload,
                savedContent: payload.content ?? tab.content,
                // Preserve keystrokes made while the request was in flight.
                // The returned revision/savedContent describe the snapshot
                // persisted by this PUT; a newer local value remains dirty.
                content: tab.content,
              }
            : tab,
        ),
      );
      void loadGit(gitStaged);
    } catch (error) {
      setIdeError(
        error instanceof Error ? error.message : "The file could not be saved.",
      );
    } finally {
      setSavingPath("");
    }
  }, [activeTab, gitStaged, loadGit, projectId, savingPath]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!active) return;
      const command = event.metaKey || event.ctrlKey;
      const target = event.target;
      const editable =
        target instanceof HTMLElement &&
        (target.matches("input, textarea, select") ||
          target.isContentEditable);
      if (command && event.key.toLowerCase() === "s") {
        if (editable && target !== editorRef.current) return;
        event.preventDefault();
        void saveActive();
        return;
      }
      if (editable) return;
      if (command && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setExplorerOpen((current) => !current);
      }
      if (command && event.key.toLowerCase() === "j") {
        event.preventDefault();
        setBottomOpen((current) => !current);
        setBottomPanel("terminal");
        window.setTimeout(() => terminalInputRef.current?.focus(), 0);
      }
      if (command && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setExplorerOpen(true);
        window.setTimeout(() => treeFilterRef.current?.focus(), 0);
      }
      if (command && event.key === ".") {
        event.preventDefault();
        setAgentOpen((current) => !current);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, saveActive]);

  useEffect(() => {
    bottomOutputRef.current?.scrollTo({
      top: bottomOutputRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [terminalEntries]);

  const visibleTree = useMemo(() => {
    const query = treeFilter.trim().toLowerCase();
    const sorted = [...tree].sort((left, right) => {
      const leftParent = left.path.split("/").slice(0, -1).join("/");
      const rightParent = right.path.split("/").slice(0, -1).join("/");
      if (leftParent === rightParent && left.type !== right.type) {
        return left.type === "directory" ? -1 : 1;
      }
      return left.path.localeCompare(right.path);
    });

    return sorted.filter((entry) => {
      if (
        !query &&
        [...collapsedDirectories].some(
          (directory) =>
            entry.path !== directory && entry.path.startsWith(`${directory}/`),
        )
      ) {
        return false;
      }
      return !query || entry.path.toLowerCase().includes(query);
    });
  }, [collapsedDirectories, tree, treeFilter]);

  const openFile = async (entry: TreeEntry) => {
    if (entry.type === "directory") {
      setCollapsedDirectories((current) => {
        const next = new Set(current);
        if (next.has(entry.path)) next.delete(entry.path);
        else next.add(entry.path);
        return next;
      });
      return;
    }

    if (
      tabs.some((tab) => tab.path === entry.path) ||
      openingPathsRef.current.has(entry.path)
    ) {
      setActivePath(entry.path);
      return;
    }

    openingPathsRef.current.add(entry.path);
    setIdeError("");
    setTabs((current) => [
      ...current,
      {
        projectId,
        path: entry.path,
        content: "",
        savedContent: "",
        revision: "",
        size: 0,
        modifiedAt: "",
        loading: true,
      },
    ]);
    setActivePath(entry.path);

    try {
      const response = await apiFetch(
        `/api/ide/file?path=${encodeURIComponent(entry.path)}&projectId=${encodeURIComponent(projectId)}`,
      );
      if (!response.ok) {
        throw new Error(
          await apiError(
            response,
            "This file could not be opened. It may be binary, too large, or no longer exist.",
          ),
        );
      }
      const payload = (await response.json()) as FilePayload;
      if (payload.projectId !== currentProjectIdRef.current) return;
      setTabs((current) => {
        const canonicalAlreadyOpen = current.some(
          (tab) => tab.path === payload.path && tab.path !== entry.path,
        );
        if (canonicalAlreadyOpen) {
          return current.filter((tab) => tab.path !== entry.path);
        }
        return current.map((tab) =>
          tab.path === entry.path
            ? { ...payload, savedContent: payload.content, loading: false }
            : tab,
        );
      });
      setActivePath((current) =>
        current === entry.path ? payload.path : current,
      );
    } catch (error) {
      setTabs((current) => current.filter((tab) => tab.path !== entry.path));
      setActivePath((current) => (current === entry.path ? "" : current));
      setIdeError(
        error instanceof Error ? error.message : "This file could not be opened.",
      );
    } finally {
      openingPathsRef.current.delete(entry.path);
    }
  };

  const quickOpenPath = () => {
    if (!treeFilter) return;
    const exact = tree.find(
      (entry) => entry.type === "file" && entry.path === treeFilter,
    );
    void openFile(
      exact ?? {
        path: treeFilter,
        name: treeFilter.split("/").at(-1) ?? treeFilter,
        type: "file",
      },
    );
  };

  const closeTab = (path: string) => {
    const tab = tabs.find((candidate) => candidate.path === path);
    if (
      tab &&
      tab.content !== tab.savedContent &&
      !window.confirm(`Discard unsaved changes in ${tab.path}?`)
    ) {
      return;
    }
    setTabs((current) => {
      const index = current.findIndex((candidate) => candidate.path === path);
      const next = current.filter((candidate) => candidate.path !== path);
      if (activePath === path) {
        setActivePath(next[Math.max(0, index - 1)]?.path ?? next[0]?.path ?? "");
      }
      return next;
    });
  };

  const reloadActive = async () => {
    if (!activeTab) return;
    if (
      isDirty &&
      !window.confirm(`Discard unsaved changes and reload ${activeTab.path}?`)
    ) {
      return;
    }
    const path = activeTab.path;
    setTabs((current) =>
      current.map((tab) => (tab.path === path ? { ...tab, loading: true } : tab)),
    );
    try {
      const response = await apiFetch(
        `/api/ide/file?path=${encodeURIComponent(path)}&projectId=${encodeURIComponent(projectId)}`,
      );
      if (!response.ok) {
        throw new Error(await apiError(response, "The file could not be reloaded."));
      }
      const payload = (await response.json()) as FilePayload;
      if (payload.projectId !== currentProjectIdRef.current) return;
      setTabs((current) =>
        current.map((tab) =>
          tab.path === path
            ? { ...payload, savedContent: payload.content, loading: false }
            : tab,
        ),
      );
      setIdeError("");
    } catch (error) {
      setTabs((current) =>
        current.map((tab) => (tab.path === path ? { ...tab, loading: false } : tab)),
      );
      setIdeError(
        error instanceof Error ? error.message : "The file could not be reloaded.",
      );
    }
  };

  const updateActiveContent = (content: string) => {
    setTabs((current) =>
      current.map((tab) =>
        tab.path === activePath ? { ...tab, content } : tab,
      ),
    );
  };

  const onEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Tab") return;
    event.preventDefault();
    const field = event.currentTarget;
    const start = field.selectionStart;
    const end = field.selectionEnd;
    const next = `${field.value.slice(0, start)}  ${field.value.slice(end)}`;
    updateActiveContent(next);
    window.requestAnimationFrame(() => {
      field.selectionStart = start + 2;
      field.selectionEnd = start + 2;
      setSelection({ start: start + 2, end: start + 2 });
    });
  };

  const askKrater = () => {
    if (!activeTab) {
      setIdeError("Open a file before adding editor context to Krater Pro.");
      return;
    }
    const selected = activeTab.content.slice(selection.start, selection.end);
    const context = (selected || activeTab.content).slice(0, MAX_AGENT_CONTEXT);
    const start = lineAndColumn(activeTab.content, selection.start).line;
    const end = lineAndColumn(activeTab.content, selection.end).line;
    const range =
      selected && start !== end
        ? ` (lines ${start}-${end})`
        : selected
          ? ` (line ${start})`
          : "";
    const truncated =
      (selected || activeTab.content).length > MAX_AGENT_CONTEXT
        ? "\n[Context truncated by the IDE]"
        : "";
    onAskKrater(
      `Help me with \`${activeTab.path}\`${range}. Review the context below and propose or implement the best next change.\n\n\`\`\`${extension(
        activeTab.path,
      )}\n${context}${truncated}\n\`\`\``,
    );
    setAgentOpen(true);
    setContextMenu(null);
  };

  const runTerminal = async (event: FormEvent) => {
    event.preventDefault();
    const command = terminalCommand.trim();
    if (!command || terminalBusy) return;

    const id = `terminal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setTerminalEntries((current) =>
      [
        ...current,
        {
          projectId,
          id,
          command,
          exitCode: null,
          stdout: "",
          stderr: "",
          timedOut: false,
          durationMs: 0,
          running: true,
        },
      ].slice(-MAX_TERMINAL_ENTRIES),
    );
    setCommandHistory((current) =>
      [...current.filter((entry) => entry !== command), command].slice(-50),
    );
    setHistoryIndex(-1);
    setTerminalCommand("");
    setTerminalBusy(true);
    setIdeError("");

    try {
      const response = await apiFetch("/api/ide/terminal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, command, timeoutMs: terminalTimeout }),
      });
      if (!response.ok) {
        throw new Error(
          await apiError(
            response,
            "The command was rejected. Use a non-interactive command inside the workspace.",
          ),
        );
      }
      const payload = (await response.json()) as TerminalPayload;
      if (payload.projectId !== currentProjectIdRef.current) return;
      setTerminalEntries((current) =>
        current.map((entry) =>
          entry.id === id
            ? {
                ...payload,
                id,
                command,
                stdout: boundedOutput(payload.stdout ?? ""),
                stderr: boundedOutput(payload.stderr ?? ""),
                running: false,
              }
            : entry,
        ),
      );
      void loadGit(gitStaged);
      void loadTree();
      void refreshCleanTabs();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "The command could not be run.";
      setTerminalEntries((current) =>
        current.map((entry) =>
          entry.id === id
            ? {
                ...entry,
                stderr: message,
                running: false,
                exitCode: null,
              }
            : entry,
        ),
      );
      setIdeError(message);
    } finally {
      setTerminalBusy(false);
      window.setTimeout(() => terminalInputRef.current?.focus(), 0);
    }
  };

  const terminalHistoryKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    if (!commandHistory.length) return;
    const next =
      event.key === "ArrowUp"
        ? Math.min(commandHistory.length - 1, historyIndex + 1)
        : Math.max(-1, historyIndex - 1);
    setHistoryIndex(next);
    setTerminalCommand(
      next === -1 ? "" : commandHistory[commandHistory.length - 1 - next] ?? "",
    );
  };

  const changeGitView = (staged: boolean) => {
    setGitStaged(staged);
    void loadGit(staged);
  };

  const lineNumbers = useMemo(() => {
    const count = Math.max(1, (activeTab?.content.match(/\n/g)?.length ?? 0) + 1);
    return Array.from({ length: count }, (_, index) => index + 1).join("\n");
  }, [activeTab?.content]);

  return (
    <section
      className={`ide-shell${explorerOpen ? "" : " ide-shell--no-explorer"}${
        agentOpen ? "" : " ide-shell--no-agent"
      }`}
      aria-label="Krater Pro agentic IDE"
    >
      <div className="ide-activity-rail" aria-label="IDE panels">
        <button
          className={explorerOpen ? "is-active" : ""}
          type="button"
          title="Explorer (⌘B)"
          aria-label="Toggle file explorer"
          onClick={() => setExplorerOpen((current) => !current)}
        >
          ◫
        </button>
        <button
          className={bottomOpen && bottomPanel === "git" ? "is-active" : ""}
          type="button"
          title="Source control"
          aria-label="Open source control"
          onClick={() => {
            setBottomPanel("git");
            setBottomOpen(true);
            void loadGit(gitStaged);
          }}
        >
          ⑂
          {statusLines.length > 0 && (
            <span>{Math.min(99, statusLines.length)}</span>
          )}
        </button>
        <button
          className={bottomOpen && bottomPanel === "terminal" ? "is-active" : ""}
          type="button"
          title="Terminal (⌘J)"
          aria-label="Open terminal"
          onClick={() => {
            setBottomPanel("terminal");
            setBottomOpen(true);
            window.setTimeout(() => terminalInputRef.current?.focus(), 0);
          }}
        >
          ›_
        </button>
        <span className="ide-activity-rail__spacer" />
        <button
          className={agentOpen ? "is-active is-agent" : "is-agent"}
          type="button"
          title="Krater agent (⌘.)"
          aria-label="Toggle Krater agent"
          onClick={() => setAgentOpen((current) => !current)}
        >
          ✦
        </button>
      </div>

      {explorerOpen && (
        <aside className="ide-explorer">
          <header className="ide-pane-header">
            <span>Explorer</span>
            <div>
              <button
                type="button"
                title="Collapse folders"
                aria-label="Collapse all folders"
                onClick={() =>
                  setCollapsedDirectories(
                    new Set(
                      tree
                        .filter((entry) => entry.type === "directory")
                        .map((entry) => entry.path),
                    ),
                  )
                }
              >
                ⊟
              </button>
              <button
                type="button"
                title="Refresh explorer"
                aria-label="Refresh file explorer"
                onClick={() => void loadTree()}
              >
                ↻
              </button>
            </div>
          </header>
          <div className="ide-project-heading">
            <span aria-hidden="true">▾</span>
            <strong title={treeRoot}>{projectName || "Workspace"}</strong>
          </div>
          <label className="ide-tree-filter">
            <span aria-hidden="true">⌕</span>
            <input
              ref={treeFilterRef}
              value={treeFilter}
              onChange={(event) => setTreeFilter(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                quickOpenPath();
              }}
              placeholder="Filter or enter a path"
              aria-label="Filter project files"
              spellCheck={false}
            />
            {treeFilter && (
              <button
                type="button"
                aria-label="Clear file filter"
                onClick={() => setTreeFilter("")}
              >
                ×
              </button>
            )}
          </label>
          <div className="ide-tree" aria-busy={treeLoading}>
            {treeLoading && <div className="ide-pane-state">Indexing workspace…</div>}
            {!treeLoading && !visibleTree.length && (
              <div className="ide-pane-state">
                {treeFilter ? "No matching files." : "This workspace is empty."}
              </div>
            )}
            {visibleTree.map((entry) => {
              const depth =
                entry.depth ?? Math.max(0, entry.path.split("/").length - 1);
              const collapsed = collapsedDirectories.has(entry.path);
              return (
                <button
                  key={`${entry.type}:${entry.path}`}
                  className={`ide-tree-entry${
                    entry.path === activePath ? " is-active" : ""
                  }`}
                  type="button"
                  style={{ paddingLeft: `${9 + Math.min(depth, 12) * 12}px` }}
                  title={entry.path}
                  onClick={() => void openFile(entry)}
                >
                  <span
                    className={`ide-file-glyph ide-file-glyph--${entry.type}`}
                    aria-hidden="true"
                  >
                    {entry.type === "directory" && collapsed
                      ? "›"
                      : entry.type === "directory"
                        ? "⌄"
                        : fileGlyph(entry)}
                  </span>
                  <span>{entry.name}</span>
                </button>
              );
            })}
          </div>
          {treeTruncated && (
            <div className="ide-explorer__notice">
              Large workspace · enter an exact path and press Return to open it
            </div>
          )}
        </aside>
      )}

      <div className="ide-workbench">
        <div className="ide-editor-area">
          <div className="ide-tabs" role="tablist" aria-label="Open files">
            {!tabs.length && (
              <span className="ide-tabs__empty">Open a file from Explorer</span>
            )}
            {tabs.map((tab) => {
              const dirty = tab.content !== tab.savedContent;
              return (
                <div
                  key={tab.path}
                  className={`ide-tab${tab.path === activePath ? " is-active" : ""}`}
                >
                  <button
                    className="ide-tab__select"
                    type="button"
                    role="tab"
                    aria-selected={tab.path === activePath}
                    title={tab.path}
                    onClick={() => setActivePath(tab.path)}
                  >
                    <span className="ide-tab__file">
                      {tab.path.split("/").pop()}
                    </span>
                    {dirty && <i aria-label="Unsaved changes" />}
                  </button>
                  <button
                    className="ide-tab__close"
                    type="button"
                    aria-label={`Close ${tab.path}`}
                    onClick={() => closeTab(tab.path)}
                  >
                    ×
                  </button>
                </div>
              );
            })}
            <span className="ide-tabs__spacer" />
            <button
              className="ide-tabs__tool"
              type="button"
              title="Toggle Krater agent (⌘.)"
              aria-label="Toggle Krater agent"
              onClick={() => setAgentOpen((current) => !current)}
            >
              ✦
            </button>
          </div>

          {ideError && (
            <div className="ide-error" role="alert">
              <span>!</span>
              <p>{ideError}</p>
              <button type="button" onClick={() => setIdeError("")} aria-label="Dismiss">
                ×
              </button>
            </div>
          )}

          {activeTab ? (
            <div className="ide-editor">
              <div className="ide-editor__toolbar">
                <div className="ide-breadcrumbs" title={activeTab.path}>
                  {activeTab.path.split("/").map((part, index, parts) => (
                    <span key={`${part}-${index}`}>
                      {part}
                      {index < parts.length - 1 && <i>›</i>}
                    </span>
                  ))}
                </div>
                <div className="ide-editor__actions">
                  <button
                    className="ide-ask-button"
                    type="button"
                    disabled={activeTab.loading}
                    onClick={askKrater}
                    title="Send selected code to Krater Pro"
                  >
                    <span>✦</span> Ask Krater
                  </button>
                  <button
                    type="button"
                    disabled={activeTab.loading}
                    onClick={() => void reloadActive()}
                    title="Reload file"
                  >
                    ↻
                  </button>
                  <button
                    className={isDirty ? "is-dirty" : ""}
                    type="button"
                    disabled={!isDirty || Boolean(savingPath) || activeTab.loading}
                    onClick={() => void saveActive()}
                    title="Save file (⌘S)"
                  >
                    {savingPath === activeTab.path ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>
              {activeTab.loading ? (
                <div className="ide-editor-empty">
                  <span className="ide-spinner" />
                  Opening {activeTab.path}…
                </div>
              ) : (
                <>
                  <div className="ide-code-surface">
                    <pre ref={gutterRef} className="ide-line-numbers" aria-hidden="true">
                      {lineNumbers}
                    </pre>
                    <textarea
                      ref={editorRef}
                      value={activeTab.content}
                      onChange={(event) => updateActiveContent(event.target.value)}
                      onKeyDown={onEditorKeyDown}
                      onSelect={(event) =>
                        setSelection({
                          start: event.currentTarget.selectionStart,
                          end: event.currentTarget.selectionEnd,
                        })
                      }
                      onScroll={(event) => {
                        if (gutterRef.current) {
                          gutterRef.current.scrollTop = event.currentTarget.scrollTop;
                        }
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setSelection({
                          start: event.currentTarget.selectionStart,
                          end: event.currentTarget.selectionEnd,
                        });
                        setContextMenu({
                          x: Math.min(event.clientX, window.innerWidth - 190),
                          y: Math.min(event.clientY, window.innerHeight - 90),
                        });
                      }}
                      aria-label={`Editor for ${activeTab.path}`}
                      spellCheck={false}
                      autoCapitalize="off"
                      autoComplete="off"
                    />
                  </div>
                  <footer className="ide-statusbar">
                    <span>{isDirty ? "● Modified" : "✓ Saved"}</span>
                    <span>Ln {cursor.line}, Col {cursor.column}</span>
                    <span>Spaces: 2</span>
                    <span>UTF-8</span>
                    <span>{languageFor(activeTab.path)}</span>
                  </footer>
                </>
              )}
            </div>
          ) : (
            <div className="ide-editor-empty ide-editor-empty--welcome">
              <div className="ide-empty-mark" aria-hidden="true">
                ✦
              </div>
              <strong>Krater Pro IDE</strong>
              <p>
                Open a file to edit, or ask the agent to explore and change the
                workspace for you.
              </p>
              <div className="ide-shortcuts">
                <span><kbd>⌘ P</kbd> Find file</span>
                <span><kbd>⌘ B</kbd> Explorer</span>
                <span><kbd>⌘ J</kbd> Terminal</span>
                <span><kbd>⌘ .</kbd> Agent</span>
              </div>
            </div>
          )}
        </div>

        {bottomOpen && (
          <section className="ide-bottom-panel">
            <header className="ide-bottom-tabs">
              <button
                className={bottomPanel === "terminal" ? "is-active" : ""}
                type="button"
                onClick={() => setBottomPanel("terminal")}
              >
                Terminal
              </button>
              <button
                className={bottomPanel === "git" ? "is-active" : ""}
                type="button"
                onClick={() => {
                  setBottomPanel("git");
                  void loadGit(gitStaged);
                }}
              >
                Source control
                {statusLines.length > 0 && <span>{statusLines.length}</span>}
              </button>
              <span className="ide-bottom-tabs__spacer" />
              {bottomPanel === "terminal" && (
                <>
                  <label className="ide-timeout">
                    Timeout
                    <select
                      value={terminalTimeout}
                      onChange={(event) => setTerminalTimeout(Number(event.target.value))}
                      disabled={terminalBusy}
                    >
                      <option value={5_000}>5s</option>
                      <option value={15_000}>15s</option>
                      <option value={30_000}>30s</option>
                    </select>
                  </label>
                  <button
                    type="button"
                    aria-label="Clear terminal"
                    title="Clear terminal"
                    onClick={() => setTerminalEntries([])}
                  >
                    ⌫
                  </button>
                </>
              )}
              {bottomPanel === "git" && (
                <button
                  type="button"
                  aria-label="Refresh Git"
                  title="Refresh Git"
                  onClick={() => void loadGit(gitStaged)}
                >
                  ↻
                </button>
              )}
              <button
                type="button"
                aria-label="Close bottom panel"
                title="Close panel"
                onClick={() => setBottomOpen(false)}
              >
                ×
              </button>
            </header>

            {bottomPanel === "terminal" ? (
              <div className="ide-terminal">
                <div ref={bottomOutputRef} className="ide-terminal__output" aria-live="polite">
                  {!terminalEntries.length && (
                    <div className="ide-terminal__welcome">
                      Krater Pro workspace terminal · commands are bounded and
                      non-interactive
                    </div>
                  )}
                  {terminalEntries.map((entry) => (
                    <section key={entry.id} className="ide-terminal-entry">
                      <div className="ide-terminal-entry__command">
                        <span>❯</span>
                        <code>{entry.command}</code>
                        <i className={entry.exitCode === 0 ? "is-success" : ""}>
                          {terminalStatus(entry)}
                        </i>
                      </div>
                      {entry.stdout && <pre>{entry.stdout}</pre>}
                      {entry.stderr && <pre className="is-stderr">{entry.stderr}</pre>}
                    </section>
                  ))}
                </div>
                <form className="ide-terminal__prompt" onSubmit={runTerminal}>
                  <span aria-hidden="true">❯</span>
                  <input
                    ref={terminalInputRef}
                    value={terminalCommand}
                    onChange={(event) => setTerminalCommand(event.target.value)}
                    onKeyDown={terminalHistoryKey}
                    placeholder="Run a workspace command…"
                    aria-label="Terminal command"
                    spellCheck={false}
                    autoComplete="off"
                    disabled={terminalBusy}
                  />
                  <button
                    type="submit"
                    disabled={!terminalCommand.trim() || terminalBusy}
                  >
                    {terminalBusy ? "Running…" : "Run"}
                  </button>
                </form>
              </div>
            ) : (
              <div className="ide-git">
                <aside className="ide-git__status">
                  <div className="ide-git__heading">
                    <strong title={gitBranch || "Git branch"}>
                      {gitBranch ? `${gitBranch} · Changes` : "Changes"}
                    </strong>
                    <span>{statusLines.length}</span>
                  </div>
                  {gitLoading && !gitStatus && (
                    <div className="ide-pane-state">Reading repository…</div>
                  )}
                  {gitError && (
                    <div className="ide-pane-state ide-pane-state--error">
                      {gitError}
                    </div>
                  )}
                  {!gitLoading && !statusLines.length && (
                    <div className="ide-pane-state">
                      {gitError ? "Source control is unavailable." : "Working tree clean."}
                    </div>
                  )}
                  {statusLines.map((line, index) => {
                    const statusEntry = gitEntries[index];
                    const displayPath = statusEntry
                      ? statusEntry.originalPath
                        ? `${statusEntry.originalPath} → ${statusEntry.path}`
                        : statusEntry.path
                      : line.slice(3);
                    const statusCode = statusEntry
                      ? `${statusEntry.index}${statusEntry.workingTree}`.trim() || "M"
                      : line.slice(0, 2).trim() || "M";
                    const targetPath =
                      statusEntry?.path ??
                      line.slice(3).split(" -> ").at(-1)?.trim();
                    return (
                    <button
                      key={`${line}-${index}`}
                      type="button"
                      title={line}
                      onClick={() => {
                        const entry = tree.find(
                          (candidate) =>
                            candidate.type === "file" &&
                            candidate.path === targetPath,
                        );
                        if (entry) {
                          void openFile(entry);
                        } else if (targetPath) {
                          void openFile({
                            path: targetPath,
                            name: targetPath.split("/").at(-1) ?? targetPath,
                            type: "file",
                          });
                        }
                      }}
                    >
                      <span>{statusCode}</span>
                      <code>{displayPath}</code>
                    </button>
                    );
                  })}
                </aside>
                <div className="ide-git__diff">
                  <div className="ide-git__switch">
                    <button
                      className={!gitStaged ? "is-active" : ""}
                      type="button"
                      onClick={() => changeGitView(false)}
                    >
                      Working tree
                    </button>
                    <button
                      className={gitStaged ? "is-active" : ""}
                      type="button"
                      onClick={() => changeGitView(true)}
                    >
                      Staged
                    </button>
                  </div>
                  <pre aria-label={gitStaged ? "Staged Git diff" : "Working tree Git diff"}>
                    {gitLoading
                      ? "Loading diff…"
                      : gitDiff
                        ? gitDiff.split("\n").map((line, index) => (
                            <span className={diffClass(line)} key={`${index}-${line}`}>
                              {line}
                              {"\n"}
                            </span>
                          ))
                        : "No changes in this view."}
                  </pre>
                </div>
              </div>
            )}
          </section>
        )}
        {!bottomOpen && (
          <button
            className="ide-bottom-reopen"
            type="button"
            onClick={() => setBottomOpen(true)}
          >
            <span>›_</span> Terminal &amp; source control
          </button>
        )}
      </div>

      {agentOpen && (
        <aside className="ide-agent">
          <header className="ide-pane-header">
            <span>
              <i>{agentBusy ? "●" : "✦"}</i>
              Krater agent
              {agentBusy && <em>working</em>}
            </span>
            <button
              type="button"
              aria-label="Close Krater agent"
              onClick={() => setAgentOpen(false)}
            >
              ×
            </button>
          </header>
          <div className="ide-agent__content">{assistant}</div>
        </aside>
      )}

      {contextMenu && (
        <div
          className="ide-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
          onClick={(event) => event.stopPropagation()}
        >
          <button type="button" role="menuitem" onClick={askKrater}>
            <span>✦</span>
            <div>
              <strong>Ask Krater</strong>
              <small>
                {selection.start === selection.end
                  ? "Use this file as context"
                  : "Use selected code as context"}
              </small>
            </div>
          </button>
        </div>
      )}
    </section>
  );
}

import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import TypeScriptWorker from "monaco-editor/language/typescript/ts.worker?worker";

type MonacoEnvironment = {
  getWorker(moduleId: string, label: string): Worker;
};

type MonacoGlobal = typeof globalThis & {
  MonacoEnvironment?: MonacoEnvironment;
};

type ModelEntry = {
  model: monaco.editor.ITextModel;
  viewState: monaco.editor.ICodeEditorViewState | null;
};

export type MonacoSelection = {
  start: number;
  end: number;
};

export type MonacoContextMenu = MonacoSelection & {
  x: number;
  y: number;
};

export type MonacoCodeEditorProps = {
  resourceKey: string;
  openResourceKeys: readonly string[];
  value: string;
  language: string;
  ariaLabel: string;
  onChange: (value: string) => void;
  onSelectionChange: (selection: MonacoSelection) => void;
  onContextMenu: (menu: MonacoContextMenu) => void;
  onSave: () => void;
};

const monacoGlobal = globalThis as MonacoGlobal;
monacoGlobal.MonacoEnvironment = {
  getWorker(_moduleId, label) {
    if (label === "json") return new JsonWorker();
    if (label === "css" || label === "scss" || label === "less") {
      return new CssWorker();
    }
    if (label === "html" || label === "handlebars" || label === "razor") {
      return new HtmlWorker();
    }
    if (label === "typescript" || label === "javascript") {
      return new TypeScriptWorker();
    }
    return new EditorWorker();
  },
};

let themeRegistered = false;

function registerTheme() {
  if (themeRegistered) return;
  monaco.editor.defineTheme("krater-proof-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "686b72" },
      { token: "keyword", foreground: "dd865c" },
      { token: "number", foreground: "d6b06d" },
      { token: "string", foreground: "a5bc7b" },
      { token: "type", foreground: "77aeb1" },
    ],
    colors: {
      "editor.background": "#090b0e",
      "editor.foreground": "#c9c8c4",
      "editor.selectionBackground": "#713f2d70",
      "editor.inactiveSelectionBackground": "#713f2d42",
      "editor.lineHighlightBackground": "#111419",
      "editor.lineHighlightBorder": "#00000000",
      "editorCursor.foreground": "#f29162",
      "editorLineNumber.foreground": "#444850",
      "editorLineNumber.activeForeground": "#858992",
      "editorIndentGuide.background1": "#1c2025",
      "editorIndentGuide.activeBackground1": "#343941",
      "editorWhitespace.foreground": "#2c3037",
      "editorWidget.background": "#111419",
      "editorWidget.border": "#292e35",
      "editorSuggestWidget.background": "#111419",
      "editorSuggestWidget.border": "#292e35",
      "editorSuggestWidget.selectedBackground": "#252a31",
      "input.background": "#0c0f13",
      "input.border": "#292e35",
      "focusBorder": "#c36f494d",
      "scrollbar.shadow": "#00000000",
      "scrollbarSlider.background": "#3b404844",
      "scrollbarSlider.hoverBackground": "#51576066",
      "scrollbarSlider.activeBackground": "#666d7777",
    },
  });
  themeRegistered = true;
}

function resourceUri(resourceKey: string) {
  return monaco.Uri.from({
    scheme: "krater",
    authority: "workspace",
    path: `/${encodeURIComponent(resourceKey)}`,
  });
}

export default function MonacoCodeEditor({
  resourceKey,
  openResourceKeys,
  value,
  language,
  ariaLabel,
  onChange,
  onSelectionChange,
  onContextMenu,
  onSave,
}: MonacoCodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelsRef = useRef(new Map<string, ModelEntry>());
  const activeResourceRef = useRef(resourceKey);
  const applyingExternalValueRef = useRef(false);
  const onChangeRef = useRef(onChange);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onContextMenuRef = useRef(onContextMenu);
  const onSaveRef = useRef(onSave);

  onChangeRef.current = onChange;
  onSelectionChangeRef.current = onSelectionChange;
  onContextMenuRef.current = onContextMenu;
  onSaveRef.current = onSave;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    registerTheme();
    const uri = resourceUri(resourceKey);
    const model =
      monaco.editor.getModel(uri) ??
      monaco.editor.createModel(value, language, uri);
    if (model.getValue() !== value) model.setValue(value);
    if (model.getLanguageId() !== language) {
      monaco.editor.setModelLanguage(model, language);
    }
    modelsRef.current.set(resourceKey, { model, viewState: null });

    const editor = monaco.editor.create(container, {
      model,
      theme: "krater-proof-dark",
      ariaLabel,
      accessibilitySupport: "auto",
      automaticLayout: true,
      bracketPairColorization: { enabled: true },
      contextmenu: false,
      cursorBlinking: "smooth",
      cursorSmoothCaretAnimation: "on",
      detectIndentation: true,
      fontFamily:
        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontLigatures: false,
      fontSize: 11,
      glyphMargin: false,
      guides: {
        bracketPairs: true,
        indentation: true,
      },
      lineHeight: 18,
      lineNumbersMinChars: 3,
      minimap: { enabled: false },
      padding: { top: 11, bottom: 28 },
      renderLineHighlight: "line",
      roundedSelection: false,
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      stickyScroll: { enabled: false },
      tabIndex: 0,
      wordWrap: "off",
    });
    editorRef.current = editor;

    const contentSubscription = editor.onDidChangeModelContent(() => {
      if (!applyingExternalValueRef.current) {
        onChangeRef.current(editor.getValue());
      }
    });
    const selectionSubscription = editor.onDidChangeCursorSelection((event) => {
      const activeModel = editor.getModel();
      if (!activeModel) return;
      onSelectionChangeRef.current({
        start: activeModel.getOffsetAt(event.selection.getStartPosition()),
        end: activeModel.getOffsetAt(event.selection.getEndPosition()),
      });
    });
    const contextMenuSubscription = editor.onContextMenu((event) => {
      const activeModel = editor.getModel();
      const selectedRange = editor.getSelection();
      if (!activeModel || !selectedRange) return;
      onContextMenuRef.current({
        start: activeModel.getOffsetAt(selectedRange.getStartPosition()),
        end: activeModel.getOffsetAt(selectedRange.getEndPosition()),
        x: event.event.posx,
        y: event.event.posy,
      });
    });
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => onSaveRef.current(),
    );

    return () => {
      contentSubscription.dispose();
      selectionSubscription.dispose();
      contextMenuSubscription.dispose();
      editor.dispose();
      editorRef.current = null;
      for (const entry of modelsRef.current.values()) entry.model.dispose();
      modelsRef.current.clear();
    };
    // Monaco is constructed exactly once. Subsequent prop changes are applied
    // to its model in the effects below, preserving undo and view state per tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const previousResource = activeResourceRef.current;
    if (previousResource !== resourceKey) {
      const previous = modelsRef.current.get(previousResource);
      if (previous) previous.viewState = editor.saveViewState();
    }

    let entry = modelsRef.current.get(resourceKey);
    if (!entry || entry.model.isDisposed()) {
      const uri = resourceUri(resourceKey);
      const existingModel = monaco.editor.getModel(uri);
      entry = {
        model:
          existingModel ?? monaco.editor.createModel(value, language, uri),
        viewState: null,
      };
      modelsRef.current.set(resourceKey, entry);
    }

    if (entry.model.getLanguageId() !== language) {
      monaco.editor.setModelLanguage(entry.model, language);
    }
    entry.model.updateOptions({ insertSpaces: true, tabSize: 2 });
    if (entry.model.getValue() !== value) {
      applyingExternalValueRef.current = true;
      try {
        entry.model.setValue(value);
      } finally {
        applyingExternalValueRef.current = false;
      }
    }

    if (editor.getModel() !== entry.model) {
      editor.setModel(entry.model);
      if (entry.viewState) editor.restoreViewState(entry.viewState);
    }
    editor.updateOptions({ ariaLabel });
    activeResourceRef.current = resourceKey;
  }, [ariaLabel, language, resourceKey, value]);

  useEffect(() => {
    const open = new Set(openResourceKeys);
    for (const [key, entry] of modelsRef.current) {
      if (key === resourceKey || open.has(key)) continue;
      if (editorRef.current?.getModel() === entry.model) continue;
      entry.model.dispose();
      modelsRef.current.delete(key);
    }
  }, [openResourceKeys, resourceKey]);

  return (
    <div
      ref={containerRef}
      className="ide-monaco-editor"
      data-editor-resource={resourceKey}
    />
  );
}

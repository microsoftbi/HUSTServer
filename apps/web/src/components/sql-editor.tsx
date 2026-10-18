import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor/editor/editor.api.js';
// 注册 SQL 语言（懒加载语法定义），并只引入 editor 核心，控制产物体积。
import 'monaco-editor/languages/definitions/sql/register.js';
// worker 由 Vite 打包为独立 chunk，不依赖任何外部 CDN。
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';

self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
} as monaco.Environment;

export interface SqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** 编辑器高度（px） */
  height?: number;
  /** Ctrl/Cmd + Enter 触发 */
  onRun?: () => void;
  placeholder?: string;
}

/** Monaco 封装的只读 SQL 编辑器（本地打包，懒加载）。 */
export function SqlEditor({ value, onChange, height = 200, onRun, placeholder }: SqlEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  // 用 ref 保存最新回调，避免每次外部重渲染都重建编辑器。
  const onChangeRef = useRef(onChange);
  const onRunRef = useRef(onRun);
  onChangeRef.current = onChange;
  onRunRef.current = onRun;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const editor = monaco.editor.create(el, {
      value,
      language: 'sql',
      theme: 'vs',
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 13,
      automaticLayout: true,
      placeholder,
    });
    editorRef.current = editor;
    const sub = editor.onDidChangeModelContent(() => {
      onChangeRef.current(editor.getValue());
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      onRunRef.current?.();
    });
    return () => {
      sub.dispose();
      editor.dispose();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 外部 value 变化时同步到编辑器（与当前值不一致才写入，避免打断输入）。
  useEffect(() => {
    const editor = editorRef.current;
    if (editor && editor.getValue() !== value) {
      editor.setValue(value);
    }
  }, [value]);

  return (
    <div
      ref={containerRef}
      className="overflow-hidden rounded-md border border-border"
      style={{ height }}
    />
  );
}

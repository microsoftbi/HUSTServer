import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor/editor/editor.api.js';
// 注册 Markdown 语言（懒加载语法定义），复用 editor 核心，不引入新依赖。
import 'monaco-editor/languages/definitions/markdown/register.js';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';

self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
} as monaco.Environment;

export interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** 编辑器高度（px） */
  height?: number;
  placeholder?: string;
}

/** Monaco 封装的 Markdown 编辑器：自动换行、无小地图，适合写说明文档。 */
export function MarkdownEditor({ value, onChange, height = 320, placeholder }: MarkdownEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const editor = monaco.editor.create(el, {
      value,
      language: 'markdown',
      theme: 'vs',
      minimap: { enabled: false },
      wordWrap: 'on',
      scrollBeyondLastLine: false,
      lineNumbers: 'off',
      folding: false,
      fontSize: 13,
      automaticLayout: true,
      placeholder,
    });
    editorRef.current = editor;
    const sub = editor.onDidChangeModelContent(() => {
      onChangeRef.current(editor.getValue());
    });
    return () => {
      sub.dispose();
      editor.dispose();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 外部值变化时同步（与当前值不一致才写入，避免打断输入）
  useEffect(() => {
    const editor = editorRef.current;
    if (editor && editor.getValue() !== value) editor.setValue(value);
  }, [value]);

  return (
    <div
      ref={containerRef}
      className="overflow-hidden rounded-md border border-border"
      style={{ height }}
    />
  );
}

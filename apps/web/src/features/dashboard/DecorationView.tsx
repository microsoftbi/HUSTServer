import { useEffect, useRef, useState } from "react";
import type { ChartWidget, DecorationConfig, TextAlign, VerticalAlign } from "@bi/types";
import { decorationOf } from "@bi/lib/decoration";

interface DecorationViewProps {
  widget: ChartWidget;
  /** 未提供时不可内联编辑（只读预览 / 演示模式） */
  onChange?: (patch: Partial<ChartWidget>) => void;
}

const JUSTIFY: Record<TextAlign, string> = {
  left: "flex-start",
  center: "center",
  right: "flex-end",
};

const ALIGN: Record<VerticalAlign, string> = {
  top: "flex-start",
  middle: "center",
  bottom: "flex-end",
};

/** 装饰元素渲染：文本框 / 图像 / 形状 */
export function DecorationView({ widget, onChange }: DecorationViewProps) {
  const cfg = decorationOf(widget);

  if (widget.type === "image") {
    return <ImageDecor cfg={cfg} />;
  }
  if (widget.type === "shape") {
    return <ShapeDecor cfg={cfg} />;
  }
  return (
    <TextDecor
      cfg={cfg}
      editable={!!onChange}
      onCommit={(text) => onChange?.({ decoration: { ...cfg, text } })}
    />
  );
}

function TextDecor({
  cfg,
  editable,
  onCommit,
}: {
  cfg: DecorationConfig;
  editable: boolean;
  onCommit: (text: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(cfg.text);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) setDraft(cfg.text);
  }, [cfg.text, editing]);

  useEffect(() => {
    if (!editing) return;
    const el = ref.current;
    el?.focus();
    el?.select();
  }, [editing]);

  const textStyle = {
    fontSize: cfg.fontSize,
    fontWeight: cfg.bold ? 600 : 400,
    color: cfg.color,
    textAlign: cfg.align,
    whiteSpace: "pre-wrap" as const,
    lineHeight: 1.4,
  };

  function commit() {
    setEditing(false);
    if (draft !== cfg.text) onCommit(draft);
  }

  return (
    <div
      className="flex h-full w-full overflow-hidden"
      style={{
        justifyContent: JUSTIFY[cfg.align],
        alignItems: ALIGN[cfg.verticalAlign],
      }}
    >
      {editing ? (
        <textarea
          ref={ref}
          data-no-drag
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setDraft(cfg.text);
              setEditing(false);
            }
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              commit();
            }
          }}
          className="h-full w-full resize-none border-0 bg-transparent p-0 outline-none"
          style={textStyle}
        />
      ) : (
        <div
          className="h-full w-full"
          style={textStyle}
          onDoubleClick={() => {
            if (editable) setEditing(true);
          }}
        >
          {cfg.text || (
            <span className="text-muted-foreground/60">
              {editable ? "双击编辑文本" : ""}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function ImageDecor({ cfg }: { cfg: DecorationConfig }) {
  if (!cfg.imageUrl) {
    return (
      <div className="flex h-full w-full items-center justify-center rounded border border-dashed border-border bg-muted/30 px-2 text-center text-xs text-muted-foreground">
        在「设置视觉对象格式 → 图像」中填写图片地址
      </div>
    );
  }
  return (
    <img
      src={cfg.imageUrl}
      alt=""
      draggable={false}
      className="h-full w-full select-none"
      style={{ objectFit: cfg.imageFit }}
    />
  );
}

function ShapeDecor({ cfg }: { cfg: DecorationConfig }) {
  if (cfg.shape === "line") {
    return (
      <svg className="h-full w-full" preserveAspectRatio="none" aria-hidden="true">
        <line
          x1="0"
          y1="50%"
          x2="100%"
          y2="50%"
          stroke={cfg.stroke}
          strokeWidth={cfg.strokeWidth}
        />
      </svg>
    );
  }
  return (
    <div
      className="h-full w-full"
      style={{
        background: cfg.fill,
        border: `${cfg.strokeWidth}px solid ${cfg.stroke}`,
        borderRadius: cfg.shape === "ellipse" ? "50%" : cfg.radius,
      }}
    />
  );
}

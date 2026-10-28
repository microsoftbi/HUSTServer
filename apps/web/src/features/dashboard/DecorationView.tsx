import { useEffect, useRef, useState } from "react";
import type {
  ButtonAction,
  ChartWidget,
  Dataset,
  DecorationConfig,
  TextAlign,
  VerticalAlign,
} from "@bi/types";
import { BUTTON_ICONS, decorationOf } from "@bi/lib/decoration";
import { ShapePath } from "@bi/lib/shapes";
import {
  hasPlaceholder,
  resolveTitleTemplate,
  titleFormatOf,
  titleValues,
} from "@bi/lib/title";
import type { ValueFilter } from "@bi/lib/highlight";

interface DecorationViewProps {
  widget: ChartWidget;
  /** 未提供时不可内联编辑（只读预览 / 演示模式） */
  onChange?: (patch: Partial<ChartWidget>) => void;
  /** 按钮点击：按动作类型执行（由仪表板层处理） */
  onButtonAction?: (action: ButtonAction) => void;
  /** 动态文本占位符 `{sum(销售额)}` 的取数来源 */
  dataset?: Dataset;
  filters?: ValueFilter[] | null;
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

/** 装饰元素渲染：文本框 / 图像 / 形状 / 按钮 */
export function DecorationView({
  widget,
  onChange,
  onButtonAction,
  dataset,
  filters,
}: DecorationViewProps) {
  const cfg = decorationOf(widget);

  if (widget.type === "image") {
    return <ImageDecor cfg={cfg} />;
  }
  if (widget.type === "shape") {
    return <ShapeDecor cfg={cfg} />;
  }
  if (widget.type === "button") {
    return (
      <ButtonDecor
        cfg={cfg}
        editable={!!onChange}
        onCommit={(text) => onChange?.({ decoration: { ...cfg, text } })}
        onAction={() => onButtonAction?.(cfg.action)}
      />
    );
  }
  return (
    <TextDecor
      cfg={cfg}
      editable={!!onChange}
      onCommit={(text) => onChange?.({ decoration: { ...cfg, text } })}
      dataset={dataset}
      filters={filters}
    />
  );
}

function TextDecor({
  cfg,
  editable,
  onCommit,
  dataset,
  filters,
}: {
  cfg: DecorationConfig;
  editable: boolean;
  onCommit: (text: string) => void;
  dataset?: Dataset;
  filters?: ValueFilter[] | null;
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

  // 动态文本：`本月销售额 {sum(销售额)}` 按当前筛选结果实时计算
  const display =
    dataset && hasPlaceholder(cfg.text)
      ? resolveTitleTemplate(
          cfg.text,
          titleValues(cfg.text, dataset, filters),
          (expr) => titleFormatOf(expr, dataset),
        )
      : cfg.text;

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
          {display || (
            <span className="text-muted-foreground/60">
              {editable ? "双击编辑文本" : ""}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** 按钮装饰：动作图标 + 文案，双击可直接改文案，单击执行动作 */
function ButtonDecor({
  cfg,
  editable,
  onCommit,
  onAction,
}: {
  cfg: DecorationConfig;
  editable: boolean;
  onCommit: (text: string) => void;
  onAction: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(cfg.text);
  const ref = useRef<HTMLInputElement>(null);
  const ActionIcon = BUTTON_ICONS[cfg.action] ?? BUTTON_ICONS.blank;

  useEffect(() => {
    if (!editing) setDraft(cfg.text);
  }, [cfg.text, editing]);

  useEffect(() => {
    if (!editing) return;
    const el = ref.current;
    el?.focus();
    el?.select();
  }, [editing]);

  function commit() {
    setEditing(false);
    if (draft !== cfg.text) onCommit(draft);
  }

  const shellStyle = {
    background: cfg.fill,
    border: `${cfg.strokeWidth}px solid ${cfg.stroke}`,
    borderRadius: cfg.radius,
  };
  const textStyle = {
    fontSize: cfg.fontSize,
    fontWeight: cfg.bold ? 600 : 400,
    color: cfg.color,
    textAlign: cfg.align,
  };

  return (
    <div className="flex h-full w-full items-center justify-center p-0.5">
      <div
        className="flex h-full w-full items-center justify-center overflow-hidden px-3"
        style={shellStyle}
        onDoubleClick={() => {
          if (editable) setEditing(true);
        }}
      >
        {editing ? (
          <input
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
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              }
            }}
            className="w-full border-0 bg-transparent p-0 text-center outline-none"
            style={textStyle}
          />
        ) : (
          <button
            type="button"
            data-no-drag
            onClick={onAction}
            className="flex w-full items-center justify-center gap-1.5 truncate"
            style={textStyle}
          >
            <ActionIcon className="h-3.5 w-3.5 shrink-0" style={{ color: cfg.color }} />
            <span className="truncate">{cfg.text}</span>
          </button>
        )}
      </div>
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
  return (
    <ShapePath
      kind={cfg.shape}
      className="h-full w-full"
      stroke={cfg.stroke}
      strokeWidth={cfg.strokeWidth}
      fill={cfg.fill}
      filled
    />
  );
}

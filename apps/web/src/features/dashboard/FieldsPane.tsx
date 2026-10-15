import { useMemo, useState } from "react";
import {
  Calendar,
  ChevronDown,
  Hash,
  Plus,
  Search,
  ToggleLeft,
  Type,
  type LucideIcon,
} from "lucide-react";
import { Input } from "@bi/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@bi/components/ui/select";
import { cn } from "@bi/lib/utils";
import type { Column, ColumnType, Dataset } from "@bi/types";

const TYPE_META: Record<ColumnType, { label: string; Icon: LucideIcon }> = {
  number: { label: "数字", Icon: Hash },
  date: { label: "日期", Icon: Calendar },
  boolean: { label: "布尔", Icon: ToggleLeft },
  string: { label: "文本", Icon: Type },
  unknown: { label: "未知", Icon: Type },
};

interface FieldsPaneProps {
  datasets: Dataset[];
  datasetId: string | null;
  onSelectDataset: (id: string) => void;
  onPickField: (field: Column) => void;
  onAddDataset?: () => void;
  /** 展开时占据的 flex 比例（折叠后仅保留标题栏） */
  grow?: number;
  className?: string;
}

/** 右侧「数据」窗格：展示数据集字段，可拖拽或点击添加（Power BI 数据窗格） */
export function FieldsPane({
  datasets,
  datasetId,
  onSelectDataset,
  onPickField,
  onAddDataset,
  grow = 2,
  className,
}: FieldsPaneProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(true);

  const dataset = datasets.find((d) => d.id === datasetId) ?? datasets[0];

  const fields = useMemo(() => {
    const all = dataset?.columns ?? [];
    const q = query.trim().toLowerCase();
    return q ? all.filter((c) => c.name.toLowerCase().includes(q)) : all;
  }, [dataset, query]);

  return (
    <div
      className={cn("flex min-h-0 flex-col", className)}
      style={{ flex: open ? `${grow} 1 0%` : "0 0 auto" }}
    >
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
        <button
          type="button"
          aria-label={open ? "折叠" : "展开"}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="rounded p-1 text-muted-foreground hover:bg-accent"
        >
          <ChevronDown
            className={cn("h-4 w-4 transition-transform", !open && "-rotate-90")}
          />
        </button>
        <span className="flex-1 text-sm font-semibold">数据</span>
        <button
          type="button"
          aria-label="添加数据集"
          title="添加数据集"
          onClick={() => onAddDataset?.()}
          className="rounded p-1 text-muted-foreground hover:bg-accent"
        >
          <Plus className="h-4 w-4" />
        </button>
        {dataset ? (
          <span className="text-xs text-muted-foreground">
            {dataset.rows.length} 行
          </span>
        ) : null}
      </div>

      {!open ? null : (
        <>
      <div className="space-y-2 p-3">
        {datasets.length > 0 ? (
          <Select value={dataset?.id} onValueChange={onSelectDataset}>
            <SelectTrigger className="h-8 text-sm">
              <SelectValue placeholder="选择数据集" />
            </SelectTrigger>
            <SelectContent>
              {datasets.map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <p className="text-xs text-muted-foreground">
            尚无数据集，点击上方「＋ 添加数据集」导入。
          </p>
        )}

        {dataset ? (
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索字段…"
              className="h-8 pl-8 text-sm"
            />
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-2 pb-3">
        {dataset ? (
          <ul className="space-y-0.5">
            {fields.map((c) => {
              const meta = TYPE_META[c.type] ?? TYPE_META.unknown;
              const { Icon } = meta;
              return (
                <li key={c.name}>
                  <div
                    role="button"
                    tabIndex={0}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", c.name);
                      e.dataTransfer.setData("text", c.name);
                      e.dataTransfer.setData("application/x-bi-field", c.name);
                      e.dataTransfer.effectAllowed = "copy";
                    }}
                    onClick={() => onPickField(c)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onPickField(c);
                      }
                    }}
                    className="flex cursor-grab items-center gap-2 rounded-md px-2.5 py-1.5 text-sm hover:bg-accent active:cursor-grabbing"
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="flex-1 truncate">{c.name}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {meta.label}
                    </span>
                  </div>
                </li>
              );
            })}
            {fields.length === 0 ? (
              <li className="px-2 py-4 text-center text-xs text-muted-foreground">
                无匹配字段
              </li>
            ) : null}
          </ul>
        ) : null}
      </div>
        </>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Bookmark as BookmarkIcon,
  BookmarkPlus,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsRight,
  MonitorPlay,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { cn } from "@bi/lib/utils";
import type { Bookmark } from "@bi/types";

interface BookmarksPaneProps {
  bookmarks: Bookmark[];
  /** 添加书签：捕获当前页面的筛选器、隐藏状态与切片器选择 */
  onAdd: () => void;
  /** 应用书签；silent 为真时不弹提示（用于演示视图切换） */
  onApply: (id: string, silent?: boolean) => void;
  /** 更新：用当前页面状态覆盖该书签的快照 */
  onUpdate: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  className?: string;
}

/** 「…」菜单的定位信息：按触发按钮位置在 body 上以 fixed 呈现，避免被窗格滚动容器裁剪 */
interface MenuAnchor {
  id: string;
  top: number;
  left: number;
}

/** 浮层锚点（视图菜单等） */
interface FloatAnchor {
  top: number;
  left: number;
}

const MENU_ITEMS: Array<{
  key: "rename" | "update" | "delete";
  label: string;
  Icon: typeof Pencil;
  danger?: boolean;
}> = [
  { key: "rename", label: "重命名", Icon: Pencil },
  { key: "update", label: "更新", Icon: RefreshCw },
  { key: "delete", label: "删除", Icon: Trash2, danger: true },
];

/** 书签窗格的两种视图（对齐 Power BI 的「视图」菜单） */
type PaneMode = "bookmark" | "presentation";

const MODE_OPTIONS: Array<{ value: PaneMode; label: string }> = [
  { value: "bookmark", label: "书签视图" },
  { value: "presentation", label: "演示视图" },
];

/**
 * Power BI 风格的「书签」窗格：保存 / 还原页面状态快照。
 * 点击条目即应用该书签保存的筛选器、可见性与切片器选择；
 * 每行的「…」菜单提供删除、重命名与更新（更新会用当前页面状态覆盖）。
 * 「视图」可切换到演示视图，用按钮逐个切换（上一个 / 下一个）书签。
 */
export function BookmarksPane({
  bookmarks,
  onAdd,
  onApply,
  onUpdate,
  onRename,
  onDelete,
  className,
}: BookmarksPaneProps) {
  /** 折叠 / 展开（折叠后只保留标题栏） */
  const [open, setOpen] = useState(true);
  /** 正在重命名的书签 id 与草稿名称 */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  /** 打开中的「…」菜单 */
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  /** 打开中的「视图」菜单 */
  const [viewMenu, setViewMenu] = useState<FloatAnchor | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const viewMenuRef = useRef<HTMLDivElement>(null);

  const [mode, setMode] = useState<PaneMode>("bookmark");
  /** 演示视图下当前所在的书签序号 */
  const [playIndex, setPlayIndex] = useState(0);
  /** 用 ref 保存最新回调，避免切换书签时因父组件重渲染而丢失 */
  const applyRef = useRef(onApply);
  useEffect(() => {
    applyRef.current = onApply;
  }, [onApply]);

  useEffect(() => {
    if (editingId) inputRef.current?.select();
  }, [editingId]);

  // 菜单打开时：点击外部或按 Esc 关闭
  useEffect(() => {
    if (!menu && !viewMenu) return;
    function onDown(e: MouseEvent) {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || viewMenuRef.current?.contains(target)) return;
      setMenu(null);
      setViewMenu(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setMenu(null);
        setViewMenu(null);
      }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu, viewMenu]);

  // 窗口尺寸变化或滚动时关闭浮层，避免位置错位
  useEffect(() => {
    if (!menu && !viewMenu) return;
    const close = () => {
      setMenu(null);
      setViewMenu(null);
    };
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu, viewMenu]);

  // 书签数量变化时修正当前序号
  useEffect(() => {
    setPlayIndex((i) => Math.min(i, Math.max(0, bookmarks.length - 1)));
  }, [bookmarks.length]);

  /** 跳到指定书签（上一个 / 下一个共用） */
  function goTo(index: number) {
    const target = Math.min(Math.max(index, 0), bookmarks.length - 1);
    if (bookmarks[target]) {
      setPlayIndex(target);
      applyRef.current(bookmarks[target].id, true);
    }
  }

  function startRename(b: Bookmark) {
    setEditingId(b.id);
    setDraft(b.name);
  }

  function commitRename() {
    if (!editingId) return;
    const name = draft.trim();
    if (name) onRename(editingId, name);
    setEditingId(null);
  }

  function runAction(key: "rename" | "update" | "delete", b: Bookmark) {
    setMenu(null);
    if (key === "rename") startRename(b);
    if (key === "update") onUpdate(b.id);
    if (key === "delete") onDelete(b.id);
  }

  const presentation = mode === "presentation";

  // 折叠态：只保留竖排标题，点击整条标题栏展开
  if (!open) {
    return (
      <aside
        className={cn(
          "flex min-h-0 flex-col border-l bg-background",
          className,
        )}
        style={{ width: 32, flex: "0 0 auto" }}
      >
        <button
          type="button"
          aria-label="展开书签窗格"
          title="展开"
          onClick={() => setOpen(true)}
          className="flex w-8 flex-1 items-start justify-center py-2 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <span
            className="text-sm font-semibold text-foreground"
            style={{ writingMode: "vertical-rl" }}
          >
            书签
          </span>
        </button>
      </aside>
    );
  }

  return (
    <aside
      className={cn(
        "flex min-h-0 min-w-0 flex-col border-l bg-background",
        className,
      )}
      style={{ width: 200, flex: "0 0 auto" }}
    >
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
        <BookmarkIcon className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="flex-1 text-sm font-semibold">书签</span>
        <button
          type="button"
          aria-label="折叠"
          aria-expanded
          onClick={() => setOpen(false)}
          className="rounded p-1 text-muted-foreground hover:bg-accent"
        >
          <ChevronsRight className="h-4 w-4" />
        </button>
      </div>

      {/* 添加 / 视图：图标 + 文字的横向按钮（对齐 Power BI 书签窗格顶部） */}
      <div className="flex shrink-0 items-center gap-1 border-b px-1.5 py-1">
        <button
          type="button"
          title="添加书签（捕获当前页面状态）"
          onClick={onAdd}
          className="flex h-7 flex-1 items-center justify-center gap-1 rounded px-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <BookmarkPlus className="h-3.5 w-3.5" />
          添加
        </button>
        <button
          type="button"
          title="视图：切换书签视图 / 演示视图"
          aria-haspopup="menu"
          aria-expanded={!!viewMenu}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setViewMenu(
              viewMenu
                ? null
                : { top: r.bottom + 4, left: Math.max(8, r.right - 160) },
            );
          }}
          className={cn(
            "flex h-7 flex-1 items-center justify-center gap-1 rounded px-1 text-xs transition-colors hover:bg-accent hover:text-foreground",
            viewMenu ? "bg-accent text-foreground" : "text-muted-foreground",
          )}
        >
          <MonitorPlay className="h-3.5 w-3.5" />
          视图
          <ChevronDown className="h-2.5 w-2.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-1.5">
        {bookmarks.length === 0 ? (
          <p className="px-2 py-3 text-xs leading-5 text-muted-foreground">
            暂无书签。点击上方「添加」保存当前页面状态。
          </p>
        ) : (
          bookmarks.map((b, index) => (
            <div
              key={b.id}
              className={cn(
                "group flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground",
                editingId === b.id && "bg-accent/60 text-foreground",
                presentation && playIndex === index && "bg-accent text-foreground",
              )}
            >
              {/* 名称区域：点击应用该书签（与「…」按钮互为兄弟节点，避免嵌套交互元素） */}
              <div
                role="button"
                tabIndex={0}
                onClick={() => {
                  if (editingId === b.id) return;
                  if (presentation) {
                    setPlayIndex(index);
                    onApply(b.id, true);
                    return;
                  }
                  onApply(b.id);
                }}
                onKeyDown={(e) => {
                  if (editingId === b.id) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onApply(b.id);
                  }
                }}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 outline-none"
              >
                <BookmarkIcon className="h-3 w-3 shrink-0" />
                {editingId === b.id ? (
                  <input
                    ref={inputRef}
                    value={draft}
                    autoFocus
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    className="h-5 min-w-0 flex-1 rounded border border-input bg-background px-1 text-xs outline-none focus:ring-1 focus:ring-primary"
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate" title={b.name}>
                    {b.name}
                  </span>
                )}
              </div>

              {/* 演示视图下不显示行内菜单，只保留播放控制 */}
              {!presentation ? (
                <button
                  type="button"
                  aria-label={`书签${b.name}的更多操作`}
                  aria-haspopup="menu"
                  aria-expanded={menu?.id === b.id}
                  title="更多操作"
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    const next = menu?.id === b.id;
                    setMenu(
                      next
                        ? null
                        : {
                            id: b.id,
                            top: r.bottom + 4,
                            left: Math.max(8, r.right - 160),
                          },
                    );
                  }}
                  className={cn(
                    "flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                    menu?.id === b.id ? "bg-accent text-foreground" : "opacity-60",
                    "group-hover:opacity-100",
                  )}
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          ))
        )}
      </div>

      {/* 演示视图：手动切换控制条（上一个 / 下一个，不自动播放） */}
      {presentation ? (
        <div className="flex shrink-0 items-center gap-1 border-t px-1.5 py-1">
          <button
            type="button"
            title="上一个书签"
            aria-label="上一个书签"
            disabled={playIndex <= 0 || bookmarks.length === 0}
            onClick={() => goTo(playIndex - 1)}
            className="flex h-6 items-center gap-0.5 rounded px-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            上一个
          </button>
          <span className="ml-auto mr-auto text-[10px] tabular-nums text-muted-foreground">
            {bookmarks.length === 0 ? "0 / 0" : `${playIndex + 1} / ${bookmarks.length}`}
          </span>
          <button
            type="button"
            title="下一个书签"
            aria-label="下一个书签"
            disabled={playIndex >= bookmarks.length - 1 || bookmarks.length === 0}
            onClick={() => goTo(playIndex + 1)}
            className="flex h-6 items-center gap-0.5 rounded px-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            下一个
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}

      <div className="shrink-0 border-t px-2 py-1">
        <p className="text-[10px] leading-4 text-muted-foreground">
          {presentation
            ? "演示视图下用「上一个 / 下一个」按钮逐个切换书签。"
            : "书签记录筛选器、隐藏状态与切片器选择，点击即可还原；「更新」会用当前页面状态覆盖。"}
        </p>
      </div>

      {/* 「…」菜单：重命名 / 更新 / 删除 */}
      {menu
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              style={{ position: "fixed", top: menu.top, left: menu.left }}
              className="z-50 w-40 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
            >
              {MENU_ITEMS.map(({ key, label, Icon, danger }) => {
                const b = bookmarks.find((x) => x.id === menu.id);
                if (!b) return null;
                return (
                  <div key={key}>
                    {key === "delete" ? <div className="my-1 h-px bg-muted" /> : null}
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => runAction(key, b)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-xs transition-colors hover:bg-accent focus:bg-accent focus:outline-none",
                        danger && "text-destructive hover:bg-destructive/10",
                      )}
                    >
                      <Icon className="h-3.5 w-3.5 shrink-0" />
                      {label}
                    </button>
                  </div>
                );
              })}
            </div>,
            document.body,
          )
        : null}

      {/* 「视图」菜单：书签视图 / 演示视图 */}
      {viewMenu
        ? createPortal(
            <div
              ref={viewMenuRef}
              role="menu"
              style={{ position: "fixed", top: viewMenu.top, left: viewMenu.left }}
              className="z-50 w-40 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
            >
              {MODE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={mode === opt.value}
                  onClick={() => {
                    setMode(opt.value);
                    setViewMenu(null);
                  }}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-xs transition-colors hover:bg-accent focus:bg-accent focus:outline-none"
                >
                  <Check
                    className={cn(
                      "h-3.5 w-3.5 shrink-0",
                      mode === opt.value ? "opacity-100" : "opacity-0",
                    )}
                  />
                  {opt.label}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </aside>
  );
}

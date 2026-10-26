import { useMemo, useState } from 'react';
import { Info, Search, Settings, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CATEGORY_ACCENT, NODE_CATEGORY_LABEL, NODE_META, type NodeCategory } from '@/lib/nodeMeta';
import { AboutDialog } from '@/components/settings/AboutDialog';
import { SettingsDialog } from '@/components/settings/SettingsDialog';
import { useWorkflowStore } from '@/store/workflowStore';
import { cn } from '@/lib/utils';
import type { NodeKind } from '@/types';

const CATEGORIES: NodeCategory[] = ['input', 'transform', 'output'];

/** Ribbon 分组：同一 Tab 内按用途分段，组名显示在组的右下角。 */
const RIBBON_GROUPS: Record<NodeCategory, { label: string; kinds: NodeKind[] }[]> = {
  input: [
    { label: '文件', kinds: ['inputCsv', 'inputExcel'] },
    { label: '数据库', kinds: ['inputSqlServer'] },
    { label: '手工', kinds: ['textInput'] },
  ],
  transform: [
    { label: '选择', kinds: ['select', 'filter'] },
    { label: '组合', kinds: ['join', 'union'] },
    { label: '汇总', kinds: ['aggregation', 'sort', 'runningTotal'] },
    { label: '数据准备', kinds: ['formula', 'findReplace', 'unique', 'sample', 'cleansing'] },
    { label: '拆分重组', kinds: ['textToColumns', 'crossTab', 'transpose'] },
  ],
  output: [
    { label: '数据模型', kinds: ['dataModel'] },
    { label: '文件', kinds: ['outputCsv', 'outputExcel'] },
    { label: '数据库', kinds: ['outputSqlServer'] },
    { label: '浏览', kinds: ['browser'] },
  ],
};

/**
 * 顶部 Ribbon：Tab 条切换「输入 / 转换 / 输出」，下方为该类别下的可拖拽节点分组。
 * 节点按钮可拖到画布上；运行中禁用拖拽。
 */
export function NodePalette() {
  const runStatus = useWorkflowStore((s) => s.runStatus);
  const running = runStatus === 'running';
  const [active, setActive] = useState<NodeCategory>('input');
  const [query, setQuery] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);

  const keyword = query.trim().toLowerCase();
  /** 搜索命中：按名称、说明与内部标识跨全部类别匹配。 */
  const matches = useMemo<NodeKind[]>(() => {
    if (!keyword) return [];
    return (Object.keys(NODE_META) as NodeKind[]).filter((kind) => {
      const meta = NODE_META[kind];
      return (
        meta.label.toLowerCase().includes(keyword) ||
        meta.description.toLowerCase().includes(keyword) ||
        kind.toLowerCase().includes(keyword) ||
        NODE_CATEGORY_LABEL[meta.category].toLowerCase().includes(keyword)
      );
    });
  }, [keyword]);

  const groups = keyword
    ? [{ label: `搜索结果 ${matches.length} 个`, kinds: matches }]
    : RIBBON_GROUPS[active];

  return (
    <div className="flex shrink-0 flex-col border-b border-border bg-card/40">
      {/* Tab 条 */}
      <div
        role="tablist"
        aria-label="节点类别"
        className="flex h-10 shrink-0 items-end gap-1 border-b border-border bg-muted/50 px-3"
      >
        {CATEGORIES.map((category) => (
          <button
            key={category}
            type="button"
            role="tab"
            aria-selected={active === category}
            onClick={() => {
              setActive(category);
              setQuery('');
            }}
            className={cn(
              'mb-1 h-7 rounded-md border px-4 text-xs transition-colors',
              active === category
                ? 'border-border bg-background font-semibold text-foreground shadow-sm'
                : 'border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground',
            )}
          >
            {NODE_CATEGORY_LABEL[category]}
          </button>
        ))}

        <div className="ml-auto flex items-center gap-1 pb-1.5">
          <div className="relative mr-1">
            <Search className="pointer-events-none absolute left-1.5 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索节点…"
              aria-label="搜索节点"
              className="h-6 w-36 rounded-md border border-border bg-background pl-6 pr-6 text-[11px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
            {query && (
              <button
                type="button"
                aria-label="清空搜索"
                onClick={() => setQuery('')}
                className="absolute right-1 top-1/2 flex size-4 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            )}
          </div>
          {running && (
            <span className="mr-1 text-[10px] text-muted-foreground">运行中，画布与配置已锁定。</span>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            title="系统配置"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            title="关于"
            onClick={() => setAboutOpen(true)}
          >
            <Info className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Ribbon 主体：Alteryx 风格大图标 + 图标下方名称；窗口偏窄时自动换行 */}
      <div
        role="tabpanel"
        className="flex flex-wrap items-start gap-x-2.5 gap-y-1 bg-card/30 px-2 py-1"
      >
        {groups.map((group, index) => (
          <div key={group.label} className="flex shrink-0 items-stretch gap-2.5">
            {index > 0 && <div className="my-1 w-px shrink-0 bg-border" />}
            <div className="flex flex-col">
              <div className="flex items-start gap-0.5">
                {group.kinds.map((kind) => {
                  const meta = NODE_META[kind];
                  const Icon = meta.icon;
                  return (
                    <div
                      key={meta.kind}
                      draggable={!running}
                      title={running ? '运行中，暂不可添加节点' : `${meta.label} — ${meta.description}`}
                      onDragStart={(event) => {
                        if (running) return;
                        event.dataTransfer.setData('application/husteryx-node', meta.kind);
                        event.dataTransfer.effectAllowed = 'move';
                      }}
                      className={cn(
                        'group flex w-[68px] shrink-0 flex-col items-center gap-1 rounded-md px-1 py-1 transition-colors',
                        running
                          ? 'cursor-not-allowed opacity-50 grayscale'
                          : 'cursor-grab hover:bg-accent active:cursor-grabbing',
                      )}
                    >
                      <div
                        className={cn(
                          'flex size-10 shrink-0 items-center justify-center rounded-md text-white shadow-sm',
                          CATEGORY_ACCENT[meta.category],
                        )}
                      >
                        <Icon className="size-6" />
                      </div>
                      <span className="line-clamp-2 h-[26px] w-full text-center text-[10px] leading-[13px] text-foreground">
                        {meta.label}
                      </span>
                    </div>
                  );
                })}
              </div>
              <span className="w-full pb-0.5 text-center text-[10px] text-muted-foreground">
                {group.label}
              </span>
            </div>
          </div>
        ))}
      </div>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
    </div>
  );
}

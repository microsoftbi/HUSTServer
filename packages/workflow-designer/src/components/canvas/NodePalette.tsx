import { CATEGORY_ACCENT, NODE_CATEGORY_LABEL, NODE_META, type NodeCategory } from '@/lib/nodeMeta';
import { cn } from '@/lib/utils';

const CATEGORIES: NodeCategory[] = ['input', 'transform', 'output'];

/** 顶部 ribbon：按类别分区展示可拖拽节点，组内为按钮、底部为组名，组间以竖线分隔，横向可滚动。 */
export function NodePalette() {
  return (
    <div className="flex h-16 shrink-0 items-stretch border-b border-border bg-card/40 px-3">
      <div className="flex min-w-0 flex-1 items-stretch gap-3 overflow-x-auto">
        {CATEGORIES.map((category, index) => (
          <div key={category} className="flex shrink-0 items-stretch gap-3">
            {index > 0 && <div className="my-2 w-px shrink-0 bg-border" />}
            <div className="flex shrink-0 flex-col justify-center gap-1">
              <div className="flex items-center gap-1.5">
                {Object.values(NODE_META)
                  .filter((meta) => meta.category === category)
                  .map((meta) => {
                    const Icon = meta.icon;
                    return (
                      <div
                        key={meta.kind}
                        draggable
                        title={meta.description}
                        onDragStart={(event) => {
                          event.dataTransfer.setData('application/husteryx-node', meta.kind);
                          event.dataTransfer.effectAllowed = 'move';
                        }}
                        className="flex shrink-0 cursor-grab items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1.5 transition-colors hover:border-primary/60 hover:bg-accent active:cursor-grabbing"
                      >
                        <div
                          className={cn(
                            'flex size-5 shrink-0 items-center justify-center rounded text-white',
                            CATEGORY_ACCENT[category],
                          )}
                        >
                          <Icon className="size-3" />
                        </div>
                        <span className="whitespace-nowrap text-xs font-medium">{meta.label}</span>
                      </div>
                    );
                  })}
              </div>
              <span className="text-center text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {NODE_CATEGORY_LABEL[category]}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

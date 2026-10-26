import { cn } from '../../../components/ui/utils.js';
import type { JobStepType } from '../../../types.js';
import { JOB_NODE_META } from '../lib/nodeMeta.js';

export const JOB_NODE_DND = 'application/hustserver-job-node';

/** Ribbon 分组：同一 Tab 内按用途分段，组名显示在组的右下角。 */
const RIBBON_GROUPS: Array<{ label: string; types: JobStepType[] }> = [
  { label: '工作流', types: ['workflow'] },
  { label: '数据处理', types: ['sql', 'load_model'] },
];

/**
 * 顶部 Ribbon：与工作流设计器一致，Tab 条下方以「大图标 + 名称」分组列出可拖拽的 Job 组件。
 * 组件可拖到画布上，也可以点击直接添加；运行中禁用。
 */
export function JobPalette({
  onAdd,
  disabled = false,
}: {
  onAdd: (type: JobStepType) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex shrink-0 flex-col border-b border-border bg-card/40">
      <div className="flex flex-wrap items-stretch gap-2 px-2 py-1">
        {disabled && (
          <span className="self-center px-1 text-[10px] text-muted-foreground">运行中，暂不可添加组件</span>
        )}
        {RIBBON_GROUPS.map((group, index) => (
          <div key={group.label} className="flex shrink-0 items-stretch gap-2.5">
            {index > 0 && <div className="my-1 w-px shrink-0 bg-border" />}
            <div className="flex flex-col">
              <div className="flex items-start gap-0.5">
                {group.types.map((type) => {
                  const meta = JOB_NODE_META[type];
                  const Icon = meta.icon;
                  return (
                    <button
                      key={type}
                      type="button"
                      draggable={!disabled}
                      disabled={disabled}
                      onDragStart={(event) => {
                        event.dataTransfer.setData(JOB_NODE_DND, type);
                        event.dataTransfer.effectAllowed = 'move';
                      }}
                      onClick={() => onAdd(type)}
                      title={disabled ? '运行中不可编辑' : `拖入画布或点击添加「${meta.label}」`}
                      className={cn(
                        'group flex w-[72px] shrink-0 flex-col items-center gap-1 rounded-md px-1 py-1 transition-colors',
                        disabled
                          ? 'cursor-not-allowed opacity-50 grayscale'
                          : 'cursor-grab hover:bg-accent active:cursor-grabbing',
                      )}
                    >
                      <span
                        className={cn(
                          'flex size-10 shrink-0 items-center justify-center rounded-md text-white shadow-sm',
                          meta.accent,
                        )}
                      >
                        <Icon className="size-6" />
                      </span>
                      <span className="line-clamp-2 h-[26px] w-full text-center text-[10px] leading-[13px] text-foreground">
                        {meta.label}
                      </span>
                    </button>
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
    </div>
  );
}

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { Minus, Plus, Sparkles, TrendingDown, TrendingUp } from "lucide-react";
import type {
  ChartWidget,
  Dataset,
  DecompositionSplit,
} from "@bi/types";
import { formatCell } from "@bi/lib/format";
import { fitLabel, textWidth } from "@bi/lib/treemap";
import {
  AI_HIGH,
  AI_LOW,
  buildDecomposition,
  collectColumns,
  decompositionOf,
  layoutDecomposition,
  ROOT_KEY,
  valueRatio,
  type DecompBox,
  type DecompNode,
  type RootLevelAggregate,
} from "@bi/lib/decomposition";
import type { CrossFilter, ValueFilter } from "@bi/lib/highlight";
import { usePushedAggregate } from "./services/pushdown";

interface DecompositionTreeProps {
  widget: ChartWidget;
  dataset: Dataset;
  /** 仪表板筛选器取值：首层下推时一并传给服务端 */
  filters?: ValueFilter[] | null;
  /** 交叉筛选条件：首层下推时一并传给服务端 */
  crossFilter?: CrossFilter | null;
  /** 展开状态写回视觉对象配置（随仪表板落库） */
  onChange?: (patch: Partial<ChartWidget>) => void;
}

interface HoverState {
  node: DecompNode;
  x: number;
  y: number;
}

interface MenuState {
  box: DecompBox;
}

/** 画布内边距与节点尺寸（与 Power BI 分解树的行高接近） */
const PAD = 4;
const NODE_H = 26;
const ROW_GAP = 8;
const COL_GAP = 32;
const MIN_COL_W = 110;
const MAX_COL_W = 260;

/**
 * Power BI 风格的分解树：根节点为度量合计，点击节点上的「+」按维度逐层拆分，
 * 也支持「高值 / 低值」自动拆分；节点数据条长度按根节点值归一化。
 */
export function DecompositionTree({
  widget,
  dataset,
  filters = null,
  crossFilter = null,
  onChange,
}: DecompositionTreeProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<HoverState | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const config = useMemo(() => decompositionOf(widget), [widget.decomposition]);
  const explainBy = widget.explainBy ?? [];
  const measure = widget.encoding.measures[0];
  /** 度量字段的数值格式 */
  const valueFormat = dataset.formats?.[measure?.field ?? ""];

  /**
   * 首层下推：数据集被截断时浏览器只有部分行，本地首层分组会偏小。
   * 仅当首层展开字段已固定（非 AI 拆分）且聚合可加时才改用服务端聚合。
   */
  const rootFieldRaw = config.expansions[ROOT_KEY];
  const rootField =
    rootFieldRaw && explainBy.includes(rootFieldRaw) ? rootFieldRaw : undefined;
  const additive = measure?.agg === "sum" || measure?.agg === "count";
  const canPushRoot = Boolean(measure && rootField && additive);

  const pushWidget = useMemo<ChartWidget>(() => {
    if (!canPushRoot || !measure) {
      // 不存在的度量会让下推规格直接失效，避免多余请求
      return {
        ...widget,
        encoding: { ...widget.encoding, measures: [{ field: "", agg: "sum" }] },
      };
    }
    return {
      ...widget,
      encoding: {
        ...widget.encoding,
        dimension: rootField,
        measures: [measure],
        series: undefined,
      },
      drill: undefined,
    };
  }, [widget, canPushRoot, measure, rootField]);

  const pushedRoot = usePushedAggregate(pushWidget, dataset, filters, crossFilter);

  const rootLevel = useMemo<RootLevelAggregate | null>(() => {
    if (!canPushRoot || !rootField || !pushedRoot) return null;
    const valueKey = pushedRoot.measureKeys[0];
    if (!valueKey) return null;
    return {
      field: rootField,
      groups: pushedRoot.data.map((row) => ({
        name: String(row[pushedRoot.dimensionKey] ?? ""),
        value: Number(row[valueKey] ?? 0),
      })),
    };
  }, [canPushRoot, rootField, pushedRoot]);

  const root = useMemo(
    () =>
      measure
        ? buildDecomposition(dataset, measure, explainBy, config.expansions, {
            maxBars: config.maxBars,
            aiSplits: config.aiSplits,
            rootLevel,
          })
        : null,
    [
      dataset,
      measure,
      explainBy,
      config.expansions,
      config.maxBars,
      config.aiSplits,
      rootLevel,
    ],
  );

  /** 展开状态写回配置：field 为空表示折叠 */
  function setExpansion(key: string, field?: DecompositionSplit | string) {
    if (!onChange) return;
    const expansions = { ...config.expansions };
    if (field) expansions[key] = field;
    else delete expansions[key];
    onChange({ decomposition: { ...config, expansions } });
    setMenu(null);
  }

  const headerHeight = config.showLevelHeaders ? 26 : 8;

  const columnCount = useMemo(() => (root ? collectColumns(root).length : 1), [root]);

  const columnWidth = useMemo(() => {
    const available = Math.max(0, size.w - PAD * 2 - COL_GAP * (columnCount - 1));
    const even = columnCount > 0 ? available / columnCount : MAX_COL_W;
    return Math.max(MIN_COL_W, Math.min(MAX_COL_W, Math.floor(even)));
  }, [size.w, columnCount]);

  const layout = useMemo(
    () =>
      root
        ? layoutDecomposition(root, {
            columnWidth,
            columnGap: COL_GAP,
            nodeHeight: NODE_H,
            rowGap: ROW_GAP,
            headerHeight,
            rootHeader: measure?.field ?? "",
          })
        : null,
    [root, columnWidth, headerHeight, measure],
  );

  if (!measure) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        请在配置中选择度量字段
      </div>
    );
  }

  if (!root || !layout) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        度量字段不在当前数据集中，请重新配置
      </div>
    );
  }

  const contentW = Math.max(PAD * 2 + layout.width, size.w);
  const contentH = Math.max(PAD * 2 + layout.height, size.h);
  const boxByKey = new Map(layout.boxes.map((box) => [box.node.key, box]));
  const canExpand = explainBy.length > 0;
  const ratioOf = (value: number) => valueRatio(value, root.value);

  /** 提示信息定位：靠近指针，且不超出视觉对象边界 */
  const tooltipLeft = hover
    ? Math.min(hover.x + 12, Math.max(0, size.w - 176))
    : 0;
  const tooltipTop = hover
    ? Math.min(hover.y + 12, Math.max(0, size.h - 92))
    : 0;

  return (
    <div ref={ref} className="relative h-full w-full">
      <div className="h-full w-full overflow-auto">
        <div
          className="relative"
          style={{ width: contentW, height: contentH }}
        >
          <svg
            width={contentW}
            height={contentH}
            role="img"
            aria-label={`分解树：${layout.columns} 个级别`}
          >
            <g transform={`translate(${PAD}, 0)`}>
              {config.showLevelHeaders
                ? layout.headers.map((header, index) => {
                    if (!header) return null;
                    const x = index * (columnWidth + COL_GAP);
                    return (
                      <text
                        key={`header-${index}`}
                        x={x + 2}
                        y={16}
                        fontSize={10}
                        fill="#64748b"
                        className="pointer-events-none"
                      >
                        {fitLabel(header, columnWidth - 8, 10)}
                      </text>
                    );
                  })
                : null}
              {config.showLevelHeaders ? (
                <line
                  x1={0}
                  y1={headerHeight - 6}
                  x2={layout.width}
                  y2={headerHeight - 6}
                  stroke="#e2e8f0"
                  strokeWidth={1}
                />
              ) : null}

              {/* 连接线：父节点右端 → 子节点左端（肘形折线） */}
              {config.showConnectors
                ? layout.boxes.map((box) => {
                    if (!box.parentKey) return null;
                    const parent = boxByKey.get(box.parentKey);
                    if (!parent) return null;
                    const px = parent.x + parent.w;
                    const py = parent.y + parent.h / 2;
                    const cx = box.x;
                    const cy = box.y + box.h / 2;
                    const midX = px + (cx - px) / 2;
                    return (
                      <path
                        key={`conn-${box.node.key}`}
                        d={`M${px} ${py} H${midX} V${cy} H${cx}`}
                        fill="none"
                        stroke="#cbd5e1"
                        strokeWidth={1.2}
                        className="pointer-events-none"
                      />
                    );
                  })
                : null}

              {layout.boxes.map((box) => {
                const ratio = ratioOf(box.node.value);
                const barW = config.showBars ? Math.max(0, box.w * ratio) : 0;
                const maxLabelW = Math.max(
                  0,
                  box.w - 30 - (config.showValues ? 44 : 0),
                );
                const name = fitLabel(box.node.name, maxLabelW, config.fontSize);
                const nameOnBar =
                  barW >= 8 + textWidth(name, config.fontSize) + 6;
                const valueText = config.showValues
                  ? fitLabel(formatCell(box.node.value, valueFormat), 44, config.fontSize)
                  : "";
                const valueOnBar =
                  barW >= box.w - 22 - textWidth(valueText, config.fontSize);

                return (
                  <g key={box.node.key}>
                    <g transform={`translate(${box.x}, ${box.y})`}>
                      {config.showBars ? (
                        <rect
                          width={box.w}
                          height={box.h}
                          rx={3}
                          fill="#eef2f7"
                          className="pointer-events-none"
                        />
                      ) : null}
                      {config.showBars && barW > 0 ? (
                        <rect
                          width={barW}
                          height={box.h}
                          rx={3}
                          fill={config.baseColor}
                          className="pointer-events-none"
                        />
                      ) : null}
                      <rect
                        width={box.w}
                        height={box.h}
                        rx={3}
                        fill="transparent"
                        className="cursor-default"
                        onMouseEnter={(e: MouseEvent) => {
                          const outer = ref.current?.getBoundingClientRect();
                          if (!outer) return;
                          setHover({
                            node: box.node,
                            x: e.clientX - outer.left,
                            y: e.clientY - outer.top,
                          });
                        }}
                        onMouseMove={(e: MouseEvent) => {
                          const outer = ref.current?.getBoundingClientRect();
                          if (!outer) return;
                          setHover({
                            node: box.node,
                            x: e.clientX - outer.left,
                            y: e.clientY - outer.top,
                          });
                        }}
                        onMouseLeave={() => setHover(null)}
                      />
                      <text
                        x={8}
                        y={box.h / 2}
                        dominantBaseline="central"
                        fontSize={config.fontSize}
                        fill={nameOnBar ? "#ffffff" : config.labelColor}
                        className="pointer-events-none"
                      >
                        {name}
                      </text>
                      {config.showValues && valueText ? (
                        <text
                          x={box.w - 24}
                          y={box.h / 2}
                          textAnchor="end"
                          dominantBaseline="central"
                          fontSize={config.fontSize}
                          fill={valueOnBar ? "#ffffff" : "#64748b"}
                          className="pointer-events-none"
                        >
                          {valueText}
                        </text>
                      ) : null}
                    </g>
                  </g>
                );
              })}
            </g>
          </svg>

          {/* 展开 / 折叠按钮：位于节点右端，避免与连接线重叠 */}
          {canExpand
            ? layout.boxes.map((box) => {
                const expanded = box.node.children.length > 0;
                return (
                  <button
                    key={`btn-${box.node.key}`}
                    type="button"
                    data-no-drag
                    aria-label={expanded ? "折叠节点" : "展开节点"}
                    title={expanded ? "折叠" : "展开依据"}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (expanded) setExpansion(box.node.key);
                      else setMenu({ box });
                    }}
                    className="absolute flex h-4 w-4 items-center justify-center rounded-full border border-border bg-background/90 text-muted-foreground shadow-sm transition-colors hover:border-primary/60 hover:text-primary"
                    style={{
                      left: PAD + box.x + box.w - 18,
                      top: box.y + box.h / 2 - 8,
                    }}
                  >
                    {expanded ? (
                      <Minus className="h-3 w-3" />
                    ) : (
                      <Plus className="h-3 w-3" />
                    )}
                  </button>
                );
              })
            : null}

          {menu ? (
            <>
              <div
                data-no-drag
                className="fixed inset-0 z-20"
                onClick={() => setMenu(null)}
              />
              <div
                className="absolute z-30 w-48 rounded-md border bg-background p-1 text-xs shadow-lg"
                style={{
                  left: Math.max(
                    0,
                    Math.min(
                      PAD + menu.box.x + menu.box.w - 150,
                      contentW - 196,
                    ),
                  ),
                  top: menu.box.y + menu.box.h + 4,
                }}
              >
                <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  展开依据
                </div>
                {config.aiSplits && explainBy.length > 0 ? (
                  <>
                    <MenuItem
                      icon={<TrendingUp className="h-3.5 w-3.5" />}
                      label="高值"
                      hint="找出贡献最大的类别"
                      onClick={() => setExpansion(menu.box.node.key, AI_HIGH)}
                    />
                    <MenuItem
                      icon={<TrendingDown className="h-3.5 w-3.5" />}
                      label="低值"
                      hint="找出贡献最低的类别"
                      onClick={() => setExpansion(menu.box.node.key, AI_LOW)}
                    />
                    <div className="my-1 h-px bg-border" />
                  </>
                ) : null}
                {explainBy.length === 0 ? (
                  <p className="px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
                    请先把维度字段拖入「说明依据」。
                  </p>
                ) : (
                  explainBy.map((field) => (
                    <MenuItem
                      key={field}
                      icon={<Sparkles className="h-3.5 w-3.5" />}
                      label={field}
                      onClick={() => setExpansion(menu.box.node.key, field)}
                    />
                  ))
                )}
              </div>
            </>
          ) : null}
        </div>
      </div>

      {!canExpand ? (
        <div className="pointer-events-none absolute inset-x-2 bottom-1 text-center text-[11px] text-muted-foreground">
          将字段拖入「说明依据」，再点击节点上的 + 逐层分解
        </div>
      ) : null}

      {hover ? (
        <div
          className="pointer-events-none absolute z-20 w-40 rounded-md border bg-background/95 p-2 text-[11px] shadow-md backdrop-blur-sm"
          style={{ left: tooltipLeft, top: tooltipTop }}
        >
          <div className="truncate font-medium">{hover.node.name}</div>
          {hover.node.field ? (
            <div className="truncate text-muted-foreground">
              按 {hover.node.field}
            </div>
          ) : null}
          <div className="mt-1 flex items-center justify-between gap-2">
            <span className="text-muted-foreground">值</span>
            <span className="font-medium tabular-nums">
              {formatCell(hover.node.value, valueFormat)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">占合计</span>
            <span className="tabular-nums">
              {root.value > 0
                ? `${((hover.node.value / root.value) * 100).toFixed(1)}%`
                : "-"}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  hint,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-start gap-1.5 rounded px-2 py-1.5 text-left transition-colors hover:bg-accent"
    >
      <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>
      <span className="min-w-0">
        <span className="block truncate">{label}</span>
        {hint ? (
          <span className="block text-[10px] text-muted-foreground">{hint}</span>
        ) : null}
      </span>
    </button>
  );
}

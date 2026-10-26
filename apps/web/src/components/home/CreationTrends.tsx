import { useEffect, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../../api.js';
import { Button } from '../ui/button.js';
import { Card, CardHeader, CardTitle } from '../ui/card.js';
import { ErrorNote } from '../ui/error-note.js';

/** 折线颜色（与仪表板内置调色板取色一致） */
const LINE_COLORS = ['#2563eb', '#16a34a', '#ea580c', '#7c3aed', '#dc2626', '#0891b2'];

/** 资源趋势：审计记录趋势独占一整行并置顶，其余六类一行两个折线图 */
const SERIES = [
  { key: 'audits', title: '审计', subtitle: '每天记录数', tooltip: '记录', fullRow: true },
  { key: 'workflows', title: '工作流' },
  { key: 'dashboards', title: '仪表板' },
  { key: 'models', title: '数据模型' },
  { key: 'connections', title: '连接' },
  { key: 'jobs', title: 'Job' },
  { key: 'users', title: '用户' },
] as const;

type SeriesKey = (typeof SERIES)[number]['key'];

const RANGES = [7, 30, 90] as const;

interface OverviewResult {
  days: number;
  dates: string[];
  counts: Record<SeriesKey, number[]>;
}

type State =
  | { status: 'loading' }
  | { status: 'ok'; data: OverviewResult }
  | { status: 'error'; reason: string };

/** 首页「新建趋势」：六类资源每天新建数量的折线图（管理员视角，全量） */
export function CreationTrends() {
  const [days, setDays] = useState<number>(30);
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    void api
      .get<OverviewResult>(`/api/admin/overview?days=${days}`)
      .then((data) => {
        if (!cancelled) setState({ status: 'ok', data });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: 'error', reason: (err as Error).message });
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle>新建趋势</CardTitle>
        <div className="flex items-center gap-1">
          {RANGES.map((range) => (
            <Button
              key={range}
              size="sm"
              variant={range === days ? 'primary' : 'outline'}
              onClick={() => setDays(range)}
            >
              最近 {range} 天
            </Button>
          ))}
        </div>
      </CardHeader>

      {state.status === 'loading' && (
        <p className="px-4 py-3 text-sm text-muted-foreground">加载中…</p>
      )}
      {state.status === 'error' && (
        <div className="p-4">
          <ErrorNote>{state.reason}</ErrorNote>
        </div>
      )}
      {state.status === 'ok' && (
        <div className="grid gap-3 p-4 lg:grid-cols-2">
          {SERIES.map((series, i) => {
            const subtitle = 'subtitle' in series ? series.subtitle : '每天新建';
            const tooltipLabel = 'tooltip' in series ? series.tooltip : '新建';
            const fullRow = 'fullRow' in series && series.fullRow;
            // 横轴按时间倒序：最近一天在最左，便于先看到当前状态
            const data = state.data.dates
              .map((date, idx) => ({
                date,
                value: state.data.counts[series.key][idx] ?? 0,
              }))
              .reverse();
            return (
              <div
                key={series.key}
                className={`rounded-md border border-border p-3${fullRow ? ' lg:col-span-2' : ''}`}
              >
                <div className="mb-1 text-sm font-medium">
                  {series.title} · {subtitle}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">共 {days} 天</span>
                </div>
                <div className={fullRow ? 'h-48' : 'h-40'}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis
                        dataKey="date"
                        tick={{ fontSize: 10 }}
                        tickFormatter={(date: string) => date.slice(5)}
                        minTickGap={24}
                      />
                      <YAxis tick={{ fontSize: 10 }} width={32} allowDecimals={false} />
                      <Tooltip
                        labelFormatter={(date) => `日期 ${String(date)}`}
                        formatter={(value) => [`${String(value)} 个`, tooltipLabel]}
                      />
                      <Line
                        type="linear"
                        dataKey="value"
                        stroke={LINE_COLORS[i % LINE_COLORS.length]}
                        strokeWidth={2}
                        dot={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

// 仪表板智能体抽屉：需求输入 → 逐项确认 → 预览 → 追加到当前画布。

import { useEffect, useState } from "react";
import { Bug, Check, Loader2, RotateCcw, Sparkles, Wand2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "../../../components/ui/button";
import { Modal } from "../../../components/ui/modal";
import { cn } from "@bi/lib/utils";
import type { AgentQuestion } from "./types";
import { useDashboardAgent } from "./useDashboardAgent";

const AGG_LABELS: Record<string, string> = {
  sum: "求和",
  count: "计数",
  avg: "平均",
  min: "最小",
  max: "最大",
  none: "不聚合",
};

const EXAMPLE = "用销售模型做一个仪表板：按国家和日期分析销售额，给我几个关键指标和数据卡片";

export function AgentDashboardDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const agent = useDashboardAgent();
  const { state } = agent;
  const [draft, setDraft] = useState("");
  const [reply, setReply] = useState("");
  const [applying, setApplying] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);

  // 重新打开时清空上一轮的输入，但保留未完成的对话
  useEffect(() => {
    if (open) setReply("");
  }, [open, state.question]);

  if (!open) return null;

  async function handleApply(): Promise<void> {
    setApplying(true);
    try {
      const ids = await agent.apply();
      toast.success(`已追加 ${ids.length} 个视觉对象`, {
        action: { label: "撤销", onClick: () => agent.undo(ids) },
      });
      onClose();
    } catch (err) {
      toast.error(`应用失败：${(err as Error).message}`);
    } finally {
      setApplying(false);
    }
  }

  function renderQuestion(question: AgentQuestion) {
    return (
      <div className="space-y-3">
        <div className="text-xs text-muted-foreground">
          第 {state.askedRounds} / 4 步 · {question.question}
        </div>
        <div className="space-y-2">
          {question.options.map((option) => (
            <button
              key={option.label}
              type="button"
              onClick={() => void agent.answer(option.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-left text-sm transition-colors hover:border-primary hover:bg-accent"
            >
              {option.label}
            </button>
          ))}
          <Button variant="outline" size="sm" className="w-full" onClick={() => void agent.useRecommended()}>
            <Wand2 />
            你来定（使用推荐值）
          </Button>
        </div>
        {question.allowFreeText && (
          <div className="space-y-2">
            <textarea
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              rows={2}
              placeholder="也可以直接描述，例如「按国家筛选，再加一个月度趋势图」"
              className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            />
            <Button
              size="sm"
              className="w-full"
              disabled={!reply.trim()}
              onClick={() => void agent.answerText(reply)}
            >
              提交描述
            </Button>
          </div>
        )}
      </div>
    );
  }

  function renderPreview() {
    const spec = state.spec!;
    return (
      <div className="space-y-4">
        <div>
          <div className="text-sm font-medium">{spec.name}</div>
          <div className="text-xs text-muted-foreground">
            切片器 {spec.slicers.length} · 数据卡片 {spec.kpis.length} · 图表 {spec.charts.length}
            {state.source === "template" && "（大模型不可用，使用本地模板）"}
          </div>
        </div>
        <ul className="space-y-1 text-xs text-muted-foreground">
          {spec.slicers.map((s) => (
            <li key={`s-${s.field}`}>切片器：{s.field}（{s.type ?? "dropdown"}）</li>
          ))}
          {spec.kpis.map((k) => (
            <li key={`k-${k.field}`}>
              数据卡片：{k.title} = {AGG_LABELS[k.agg] ?? k.agg}({k.field})
            </li>
          ))}
          {spec.charts.map((c, i) => (
            <li key={`c-${i}`}>
              图表：{c.title}（{c.type}
              {c.dimension ? ` · 按 ${c.dimension}` : ""}）
            </li>
          ))}
        </ul>
        {state.warnings.length > 0 && (
          <ul className="space-y-1 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
            {state.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="flex-1" onClick={() => void agent.regenerate()}>
            <RotateCcw />
            重新生成
          </Button>
          <Button size="sm" className="flex-1" disabled={applying} onClick={() => void handleApply()}>
            {applying ? <Loader2 className="animate-spin" /> : <Check />}
            应用到画布
          </Button>
        </div>
      </div>
    );
  }

  function renderBody() {
    if (state.phase === "idle") {
      return (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            描述你想要的仪表板，包括数据模型、筛选、数据卡片与图表。缺失的信息会逐项和你确认。
          </p>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={6}
            placeholder={EXAMPLE}
            className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          />
          <Button
            className="w-full"
            disabled={!draft.trim()}
            onClick={() => void agent.start(draft)}
          >
            <Sparkles />
            开始解析需求
          </Button>
        </div>
      );
    }
    if (state.phase === "parsing" || state.phase === "generating") {
      return (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="animate-spin" />
          {state.phase === "parsing" ? "正在解析需求…" : "正在生成仪表板…"}
        </div>
      );
    }
    if (state.phase === "asking" && state.question) {
      return renderQuestion(state.question);
    }
    if (state.phase === "preview" && state.spec) {
      return renderPreview();
    }
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">{state.error ?? "生成失败"}</p>
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          onClick={() => {
            agent.reset();
            setDraft(state.prompt);
          }}
        >
          <RotateCcw />
          重新开始
        </Button>
      </div>
    );
  }

  /** 调试窗口：按顺序列出每次真实发往大模型的提示词与原始返回 */
  function renderDebugModal() {
    return (
      <Modal
        open={debugOpen}
        onClose={() => setDebugOpen(false)}
        title="调试 · 发送给大模型的内容"
        className="max-w-3xl"
      >
        {state.debug.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            本次会话还没有调用大模型（未配置 API Key 或需求已在本地解析完成）。
          </p>
        ) : (
          <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
            {state.debug.map((entry, index) => (
              <div key={`${entry.stage}-${index}`} className="rounded-md border border-border">
                <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/40 px-3 py-2 text-xs">
                  <span className="rounded bg-primary/10 px-1.5 py-0.5 font-medium text-primary">
                    {entry.stage === "plan" ? "解析需求" : "生成仪表板"}
                  </span>
                  <span className="text-muted-foreground">
                    第 {index + 1} 次调用 · 数据模型 {entry.model}
                  </span>
                  {entry.error && <span className="text-destructive">失败：{entry.error}</span>}
                </div>
                {entry.messages.map((message, i) => (
                  <div key={`${message.role}-${i}`} className="border-b border-border/60 px-3 py-2 last:border-b-0">
                    <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      {message.role}
                    </div>
                    <pre className="whitespace-pre-wrap break-words font-mono text-xs text-foreground">
                      {message.content}
                    </pre>
                  </div>
                ))}
                {entry.response !== undefined && (
                  <div className="px-3 py-2">
                    <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      response
                    </div>
                    <pre className="whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
                      {entry.response}
                    </pre>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Modal>
    );
  }

  return (
    <aside
      className={cn(
        "absolute inset-y-0 right-0 z-30 flex w-[380px] flex-col border-l border-border bg-background shadow-xl",
      )}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
        <Sparkles className="h-4 w-4 text-primary" />
        <span className="text-sm font-medium">AI 生成仪表板</span>
        <button
          type="button"
          onClick={() => setDebugOpen(true)}
          className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="查看发送给大模型的全部内容"
        >
          <Bug className="h-3.5 w-3.5" />
          调试
          {state.debug.length > 0 && <span className="text-[10px]">({state.debug.length})</span>}
        </button>
        <button
          type="button"
          aria-label="关闭"
          onClick={onClose}
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{renderBody()}</div>
      {state.phase === "preview" && (
        <footer className="shrink-0 border-t border-border px-4 py-2 text-xs text-muted-foreground">
          生成结果会追加到当前页，并自动避开已有对象；确认后记得点「保存」。
        </footer>
      )}
      {renderDebugModal()}
    </aside>
  );
}

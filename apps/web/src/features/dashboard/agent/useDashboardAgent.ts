// 仪表板智能体的前端状态机：idle → parsing → asking → generating → preview → 应用。
// 应用只写画布（zustand store），不自动保存，由用户点「保存」落库。

import { useCallback, useState } from "react";
import { api, ApiClientError } from "../../../api";
import { loadModelDataset } from "../services/dataSource";
import { useDashboardStore } from "../stores/dashboardStore";
import { useDatasetStore } from "../stores/datasetStore";
import { buildWidgets } from "./apply";
import {
  emptySlots,
  type AgentAnswer,
  type AgentDebugEntry,
  type AgentQuestion,
  type AgentSlots,
  type DashboardSpec,
  type GenerateResponse,
  type PlanResponse,
} from "./types";

/** 最多向用户提问的轮数（模型 / 切片器 / 数据卡片 / 图表） */
const MAX_ASK_ROUNDS = 4;
/** 轮次用尽后自动采用推荐值的最大循环次数（防御死循环） */
const MAX_AUTO_FILL = 8;

export type AgentPhase = "idle" | "parsing" | "asking" | "generating" | "preview" | "error";

export interface AgentState {
  phase: AgentPhase;
  prompt: string;
  slots: AgentSlots;
  question: AgentQuestion | null;
  askedRounds: number;
  warnings: string[];
  spec: DashboardSpec | null;
  source: "llm" | "template" | null;
  error: string | null;
  /** 本次会话中所有真实发往大模型的请求，供「调试」窗口查看 */
  debug: AgentDebugEntry[];
}

const INITIAL: AgentState = {
  phase: "idle",
  prompt: "",
  slots: emptySlots(),
  question: null,
  askedRounds: 0,
  warnings: [],
  spec: null,
  source: null,
  error: null,
  debug: [],
};

function messageOf(err: unknown): string {
  if (err instanceof ApiClientError) {
    return `${err.message}${err.detail ? `（${err.detail}）` : ""}`;
  }
  return err instanceof Error ? err.message : String(err);
}

function mergeWarnings(...groups: string[][]): string[] {
  return [...new Set(groups.flat())];
}

export function useDashboardAgent() {
  const [state, setState] = useState<AgentState>(INITIAL);

  const fail = useCallback((err: unknown, warnings: string[], debug: AgentDebugEntry[]) => {
    setState((s) => ({
      ...s,
      phase: "error",
      error: messageOf(err),
      warnings,
      debug,
    }));
  }, []);

  /** 生成阶段：拿到规格后进入预览 */
  const generate = useCallback(
    async (
      prompt: string,
      slots: AgentSlots,
      warnings: string[],
      priorDebug: AgentDebugEntry[],
    ) => {
      setState((s) => ({
        ...s,
        phase: "generating",
        question: null,
        slots,
        warnings,
        debug: priorDebug,
      }));
      try {
        const res = await api.post<GenerateResponse>("/api/dashboard-agent/generate", {
          body: { prompt, slots },
        });
        setState({
          phase: "preview",
          prompt,
          slots,
          question: null,
          askedRounds: MAX_ASK_ROUNDS,
          warnings: mergeWarnings(warnings, res.warnings),
          spec: res.spec,
          source: res.source,
          error: null,
          debug: [...priorDebug, ...(res.debug ?? [])],
        });
      } catch (err) {
        fail(err, warnings, priorDebug);
      }
    },
    [fail],
  );

  /**
   * 解析阶段：反复调用 plan 直到槽位齐全。
   * 前 4 轮把问题交给用户，之后自动采用推荐值补齐。
   */
  const advance = useCallback(
    async (
      prompt: string,
      initialSlots: AgentSlots,
      initialAnswer: AgentAnswer | undefined,
      asked: number,
    ) => {
      let slots = initialSlots;
      let answer = initialAnswer;
      let rounds = asked;
      const warnings: string[] = [];
      const debug: AgentDebugEntry[] = [];
      try {
        for (let i = 0; i < MAX_AUTO_FILL; i += 1) {
          const res = await api.post<PlanResponse>("/api/dashboard-agent/plan", {
            body: { prompt, slots, ...(answer ? { answer } : {}) },
          });
          slots = res.slots;
          answer = undefined;
          warnings.push(...res.warnings);
          debug.push(...(res.debug ?? []));
          if (res.ready) {
            await generate(prompt, slots, mergeWarnings(warnings), debug);
            return;
          }
          const question = res.questions[0];
          if (!question) {
            await generate(prompt, slots, mergeWarnings(warnings), debug);
            return;
          }
          if (rounds < MAX_ASK_ROUNDS) {
            setState((s) => ({
              ...s,
              phase: "asking",
              slots,
              question,
              askedRounds: rounds + 1,
              warnings: mergeWarnings(warnings),
              debug,
            }));
            return;
          }
          // 轮次用尽：用推荐值兜底，继续解析
          answer = {
            slot: question.slot,
            value: question.recommended ?? question.options[0]?.value ?? "",
          };
        }
        await generate(prompt, slots, mergeWarnings(warnings), debug);
      } catch (err) {
        fail(err, mergeWarnings(warnings), debug);
      }
    },
    [fail, generate],
  );

  const start = useCallback(
    async (prompt: string) => {
      const text = prompt.trim();
      if (!text) return;
      setState({ ...INITIAL, phase: "parsing", prompt: text });
      await advance(text, emptySlots(), undefined, 0);
    },
    [advance],
  );

  /** 回答当前问题：value 为选项的 JSON 字符串，text 为自由输入 */
  const answer = useCallback(
    async (value: string) => {
      const question = state.question;
      if (!question) return;
      setState((s) => ({ ...s, phase: "parsing", question: null }));
      await advance(state.prompt, state.slots, { slot: question.slot, value }, state.askedRounds);
    },
    [advance, state.askedRounds, state.prompt, state.question, state.slots],
  );

  /** 回答自由文本（服务端会再解析一次字段） */
  const answerText = useCallback(
    async (text: string) => {
      const question = state.question;
      if (!question || !text.trim()) return;
      setState((s) => ({ ...s, phase: "parsing", question: null }));
      await advance(state.prompt, state.slots, { slot: question.slot, text }, state.askedRounds);
    },
    [advance, state.askedRounds, state.prompt, state.question, state.slots],
  );

  /** 「你来定」：直接提交推荐选项 */
  const useRecommended = useCallback(async () => {
    const question = state.question;
    if (!question) return;
    await answer(question.recommended ?? question.options[0]?.value ?? "");
  }, [answer, state.question]);

  /** 重新生成（沿用已确认的槽位） */
  const regenerate = useCallback(async () => {
    setState((s) => ({ ...s, phase: "generating", spec: null, warnings: [] }));
    await generate(state.prompt, state.slots, [], state.debug);
  }, [generate, state.debug, state.prompt, state.slots]);

  /**
   * 应用到当前仪表板：追加视觉对象并返回新增 id（供撤销）。
   * 模型尚未作为数据集存在时自动创建运行时数据集。
   */
  const apply = useCallback(async (): Promise<string[]> => {
    const { spec, slots } = state;
    if (!spec || !slots.model) throw new Error("还没有可应用的生成结果");
    const modelName = slots.model;

    const data = useDatasetStore.getState();
    let dataset = data.datasets.find(
      (d) => d.def.kind === "model" && d.def.modelName === modelName,
    );
    if (!dataset) {
      dataset = await loadModelDataset(modelName, modelName);
      data.addDataset(dataset);
    }

    const dash = useDashboardStore.getState();
    const page = dash.dashboards.find((d) => d.id === dash.activeId);
    const widgets = buildWidgets(spec, dataset.id, dataset.columns, page?.widgets ?? []);
    for (const widget of widgets) dash.addWidget(widget);
    return widgets.map((w) => w.id);
  }, [state]);

  /** 撤销刚才追加的视觉对象 */
  const undo = useCallback((ids: string[]) => {
    const dash = useDashboardStore.getState();
    for (const id of ids) dash.removeWidget(id);
  }, []);

  const reset = useCallback(() => setState(INITIAL), []);

  const busy = state.phase === "parsing" || state.phase === "generating";

  return { state, busy, start, answer, answerText, useRecommended, regenerate, apply, undo, reset };
}

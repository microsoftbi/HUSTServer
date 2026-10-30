// 仪表板智能体的前后端契约类型：与 apps/server/src/modules/dashboardAgent 保持镜像。
// 服务端只返回语义结构（字段名 / 聚合 / 图表类型），坐标与尺寸由前端本地生成。

import type { AggregateFn, SlicerType } from "@bi/types";

export type AgentSlotKey = "model" | "slicers" | "kpis" | "charts";

export interface AgentColumn {
  name: string;
  /** 逻辑类型或 DuckDB 原始类型（服务端已按用户配置合并） */
  type: string;
}

export interface AgentModelInfo {
  name: string;
  rowCount: number;
  columns: AgentColumn[];
}

export interface SpecSlicer {
  field: string;
  type?: SlicerType;
}

export interface SpecKpi {
  title: string;
  field: string;
  agg: AggregateFn;
}

export interface SpecMeasure {
  field: string;
  agg: AggregateFn;
}

export interface SpecChart {
  /** 图表类型（服务端已按白名单校验） */
  type: string;
  title: string;
  dimension?: string;
  measures: SpecMeasure[];
}

/** 生成规格：只有语义结构，没有坐标 */
export interface DashboardSpec {
  name: string;
  slicers: SpecSlicer[];
  kpis: SpecKpi[];
  charts: SpecChart[];
}

/** 槽位：null 表示「用户还没说明」，空数组表示「用户明确不要」 */
export interface AgentSlots {
  model: string | null;
  slicers: SpecSlicer[] | null;
  kpis: SpecKpi[] | null;
  charts: SpecChart[] | null;
}

export interface AgentQuestionOption {
  label: string;
  /** 槽位值的 JSON 字符串，原样回传给服务端 */
  value: string;
}

export interface AgentQuestion {
  slot: AgentSlotKey;
  question: string;
  options: AgentQuestionOption[];
  allowFreeText: boolean;
  /** 推荐选项的 value（「你来定」直接使用） */
  recommended?: string;
}

export interface AgentAnswer {
  slot: AgentSlotKey;
  value?: string;
  text?: string;
}

export interface PlanResponse {
  slots: AgentSlots;
  questions: AgentQuestion[];
  ready: boolean;
  warnings: string[];
  /** 已完成确认的槽位数量（1-4） */
  confirmed: number;
  /** 本次调用大模型的调试记录（含完整提示词与原始返回） */
  debug?: AgentDebugEntry[];
}

export interface GenerateResponse {
  spec: DashboardSpec;
  warnings: string[];
  /** llm = 大模型生成；template = 本地模板兜底 */
  source: "llm" | "template";
  /** 每次尝试调用大模型的调试记录 */
  debug?: AgentDebugEntry[];
}

/** 一次真实发往大模型的请求，供「调试」窗口展示 */
export interface AgentDebugEntry {
  stage: "plan" | "generate";
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  response?: string;
  error?: string;
}

export function emptySlots(): AgentSlots {
  return { model: null, slicers: null, kpis: null, charts: null };
}

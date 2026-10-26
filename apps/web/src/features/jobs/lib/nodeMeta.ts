import { Box, Database, Workflow, type LucideIcon } from 'lucide-react';
import type { JobNode, JobStepType } from '../../../types.js';

export interface JobNodeMeta {
  /** 面板与节点卡上的类型名 */
  label: string;
  icon: LucideIcon;
  /** 节点卡顶部色条 + 图标底色 */
  accent: string;
  /** 新建节点时的默认名称 */
  defaultName: string;
}

/** 三类 Job 节点（与后端 steps 的 type 一一对应）。 */
export const JOB_NODE_META: Record<JobStepType, JobNodeMeta> = {
  workflow: { label: '运行工作流', icon: Workflow, accent: 'bg-sky-500', defaultName: '运行工作流' },
  sql: { label: '运行 SQL', icon: Database, accent: 'bg-violet-500', defaultName: '运行 SQL' },
  load_model: { label: '加载成模型', icon: Box, accent: 'bg-emerald-500', defaultName: '加载成模型' },
};

export const DEFAULT_NODE_NAMES = Object.values(JOB_NODE_META).map((m) => m.defaultName);

export interface NodeLookups {
  workflowNames: Map<string, string>;
  connectionNames: Map<string, string>;
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** 节点卡摘要行：一眼看出这个节点实际会做什么。 */
export function describeNode(node: JobNode, lookups: NodeLookups): string {
  const config = node.config;
  if (node.type === 'workflow') {
    const id = text(config.workflowId);
    return `工作流：${(id && lookups.workflowNames.get(id)) || '（未选择）'}`;
  }
  if (node.type === 'sql') {
    const id = text(config.connectionId);
    const sql = text(config.sql).split('\n')[0]?.slice(0, 40) ?? '';
    return `连接：${(id && lookups.connectionNames.get(id)) || '（未选择）'}${sql ? ` · ${sql}` : ''}`;
  }
  const source = config.source === 'sqlserver' ? 'SQL Server' : '资源文件';
  const target =
    config.source === 'sqlserver'
      ? text(config.object) || text(config.query).slice(0, 30) || '（未选择表）'
      : text(config.resourcePath) || '（未选择文件）';
  return `${text(config.modelName) || '（未命名）'} · ${source} ${target}`;
}

/** 必填项未配置时的提示项（节点卡角标 + 属性面板说明）。 */
export function nodeIssues(node: JobNode): string[] {
  const config = node.config;
  const issues: string[] = [];
  if (node.type === 'workflow') {
    if (!text(config.workflowId)) issues.push('未选择工作流');
  } else if (node.type === 'sql') {
    if (!text(config.connectionId)) issues.push('未选择连接');
    if (!text(config.sql)) issues.push('未填写 SQL');
  } else {
    if (!text(config.modelName)) issues.push('未填写模型名');
    if (config.source === 'sqlserver') {
      if (!text(config.connectionId)) issues.push('未选择连接');
      if (!text(config.object) && !text(config.query)) issues.push('未指定表或查询');
    } else if (!text(config.resourcePath)) {
      issues.push('未选择资源文件');
    }
  }
  return issues;
}

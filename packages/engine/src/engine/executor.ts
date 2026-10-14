import type { WorkflowNode } from '../types.js';
import type { NodeContext } from '../nodes/context.js';
import { tableNameForNode } from '../util/sqlIdent.js';
import { ancestorNodeIds, compileGraph } from './graph.js';
import { nodeRegistry } from './registry.js';
import {
  getRun,
  pinRun,
  publishLog,
  publishNodeResult,
  publishRunStatus,
  type RunContext,
} from './runStore.js';

/** 按拓扑顺序执行整个工作流，并通过 runStore 推送事件。 */
export async function executeWorkflow(runId: string): Promise<void> {
  const ctx = getRun(runId);
  if (!ctx) return;

  publishRunStatus(ctx, 'running', '工作流开始执行');
  publishLog(ctx, 'info', `工作流「${ctx.workflow.name}」开始执行`);

  try {
    const compiled = compileGraph(ctx.workflow);
    // 「运行至此」：仅执行目标节点及其全部上游祖先；其余节点不参与本次运行。
    const scope = ctx.targetNodeId
      ? new Set([...ancestorNodeIds(ctx.workflow, ctx.targetNodeId), ctx.targetNodeId])
      : null;
    if (scope) {
      const targetName =
        ctx.workflow.nodes.find((n) => n.id === ctx.targetNodeId)?.name ?? ctx.targetNodeId;
      publishLog(ctx, 'info', `运行至此：执行「${targetName}」及其上游共 ${scope.size} 个节点`);
    } else if (ctx.skipNodeIds && ctx.skipNodeIds.size > 0) {
      publishLog(ctx, 'info', `从缓存继续：跳过前 ${ctx.skipNodeIds.size} 个缓存节点`);
    } else {
      publishLog(ctx, 'info', `共 ${compiled.order.length} 个节点，按拓扑顺序执行`);
    }

    for (const node of compiled.order) {
      // 范围外的节点（下游 / 无关分支）不执行、不置状态，保持原样。
      if (scope && !scope.has(node.id)) continue;
      // 复用缓存运行：缓存节点直接沿用结果，跳过执行。
      const cached = ctx.skipNodeIds?.has(node.id) ? ctx.nodeResults.get(node.id) : undefined;
      if (cached && cached.status === 'success') {
        publishNodeResult(ctx, node.id, 'success', cached.rowCount, cached.durationMs);
        publishLog(ctx, 'info', `「${node.name}」使用缓存结果（${cached.rowCount} 行）`, node.id);
        continue;
      }
      if (ctx.status === 'error') {
        markSkipped(ctx, node, '上游节点执行失败');
        continue;
      }
      const inputMap = compiled.inputNodes.get(node.id) ?? {};
      const blocked = Object.values(inputMap).some((list) =>
        list.some(({ source }) => (ctx.nodeResults.get(source)?.status ?? 'pending') !== 'success'),
      );
      if (blocked) {
        markSkipped(ctx, node, '上游节点未成功');
        continue;
      }
      await runNode(ctx, node, inputMap);
    }

    if (ctx.status === 'error') {
      // 节点失败时 runNode 只置 error 状态并正常返回（不抛异常），
      // 故需在此显式推送终止性的 run-status，否则前端会一直停留在「运行中」。
      const failed = [...ctx.nodeResults.values()].find((result) => result.status === 'error');
      const message = failed?.error ?? '工作流执行失败';
      publishRunStatus(ctx, 'error', message);
      publishLog(ctx, 'error', `工作流执行失败：${message}`);
    } else {
      ctx.status = 'success';
      // 「缓存至此」：成功后钉住本次会话，供后续运行从缓存之后继续。
      if (ctx.freeze && ctx.cacheToken && scope) {
        pinRun(ctx.runId, scope, ctx.targetNodeId ?? '');
        const boundaryName =
          ctx.workflow.nodes.find((n) => n.id === ctx.targetNodeId)?.name ?? ctx.targetNodeId;
        publishLog(ctx, 'success', `已缓存至「${boundaryName}」，后续运行将从缓存之后继续`);
      }
      publishRunStatus(ctx, 'success', '工作流执行完成');
      publishLog(ctx, 'success', '工作流执行完成');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.status = 'error';
    publishLog(ctx, 'error', `工作流执行失败：${message}`);
    publishRunStatus(ctx, 'error', message);
  }
}

async function runNode(
  ctx: RunContext,
  node: WorkflowNode,
  inputMap: Record<string, Array<{ source: string; sourceHandle: string }>>,
): Promise<void> {
  const executor = nodeRegistry[node.kind];
  const inputs: Record<string, string> = {};
  const inputLists: Record<string, string[]> = {};
  for (const [handle, upstreams] of Object.entries(inputMap)) {
    const tables = upstreams.map(({ source, sourceHandle }) =>
      tableNameForNode(source, sourceHandle),
    );
    inputLists[handle] = tables;
    // 单端口多输入时 inputs 取第一条，兼容只读取单表的执行器。
    if (tables.length > 0) inputs[handle] = tables[0];
  }
  const inputList = Object.values(inputLists).flat();
  const outputTable = tableNameForNode(node.id);

  ctx.nodeStatus.set(node.id, 'running');
  publishNodeResult(ctx, node.id, 'running', 0, 0);
  publishLog(ctx, 'info', `开始执行「${node.name}」`, node.id);

  if (!executor) {
    ctx.nodeStatus.set(node.id, 'error');
    ctx.nodeResults.set(node.id, {
      status: 'error',
      rowCount: 0,
      durationMs: 0,
      error: `未知节点类型：${node.kind}`,
    });
    publishNodeResult(ctx, node.id, 'error', 0, 0, `未知节点类型：${node.kind}`);
    ctx.status = 'error';
    return;
  }

  const startedAt = Date.now();
  const nodeCtx: NodeContext = {
    node,
    inputs,
    inputLists,
    inputList,
    connection: ctx.session.connection,
    outputTable,
    outputTableFor: (handle) => tableNameForNode(node.id, handle),
    log: (level, message) => publishLog(ctx, level, message, node.id),
  };

  try {
    const result = await executor(nodeCtx);
    const durationMs = Date.now() - startedAt;
    ctx.nodeStatus.set(node.id, 'success');
    ctx.nodeResults.set(node.id, {
      status: 'success',
      rowCount: result.rowCount,
      durationMs,
    });
    publishNodeResult(ctx, node.id, 'success', result.rowCount, durationMs);
    publishLog(
      ctx,
      'success',
      `「${node.name}」完成：${result.rowCount} 行，耗时 ${durationMs}ms`,
      node.id,
    );
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    ctx.nodeStatus.set(node.id, 'error');
    ctx.nodeResults.set(node.id, {
      status: 'error',
      rowCount: 0,
      durationMs,
      error: message,
    });
    publishNodeResult(ctx, node.id, 'error', 0, durationMs, message);
    publishLog(ctx, 'error', `「${node.name}」执行失败：${message}`, node.id);
    ctx.status = 'error';
  }
}

function markSkipped(ctx: RunContext, node: WorkflowNode, reason: string): void {
  ctx.nodeStatus.set(node.id, 'skipped');
  ctx.nodeResults.set(node.id, { status: 'skipped', rowCount: 0, durationMs: 0 });
  publishNodeResult(ctx, node.id, 'skipped', 0, 0);
  publishLog(ctx, 'warn', `跳过「${node.name}」：${reason}`, node.id);
}

import type { InputRef, MappingTargetType, OutputRef } from './types.js';

/** 提交给 POST /api/workflows 的映射草稿（不含 workflow_id，服务端回填）。 */
export interface MappingDraft {
  node_id: string;
  direction: 'input' | 'output';
  original_ref: string;
  target_type: MappingTargetType;
  target_ref: string | null;
}

export interface InputBinding {
  targetType: 'uploaded_file' | 'server_path' | 'connection';
  /** 文件绑定存 stored_name；服务端路径存绝对路径；连接存 connectionId。 */
  targetRef: string;
}

/**
 * 依据解析出的输入/输出引用与用户绑定，生成提交给后端的 mappings：
 * - 输入：有非空 targetRef 才生成；target_type 取用户选择。
 * - 输出：一律 output_dir + target_ref: null（落到服务端 output 目录）。
 */
export function buildMappingInputs(
  inputs: InputRef[],
  outputs: OutputRef[],
  bindings: Record<string, InputBinding>,
): MappingDraft[] {
  const drafts: MappingDraft[] = [];
  for (const input of inputs) {
    const binding = bindings[input.nodeId];
    if (!binding || !binding.targetRef.trim()) continue;
    drafts.push({
      node_id: input.nodeId,
      direction: 'input',
      original_ref: input.originalRef,
      target_type: binding.targetType,
      target_ref: binding.targetRef,
    });
  }
  for (const output of outputs) {
    drafts.push({
      node_id: output.nodeId,
      direction: 'output',
      original_ref: output.originalRef,
      target_type: 'output_dir',
      target_ref: null,
    });
  }
  return drafts;
}

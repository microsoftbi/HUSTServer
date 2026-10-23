import type { NodeKind } from '@/types';

/** 数据模型名称规则，与服务端保持一致。 */
const MODEL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function fieldOf(item: unknown): string {
  if (!item || typeof item !== 'object') return '';
  return str((item as { field?: unknown }).field);
}

/**
 * 返回节点尚未配置的必要属性（用于画布上显示「配置未完成」提示）。
 * 判定口径与引擎执行前的校验保持一致，避免出现「标了叹号但能跑」或「没标却报错」。
 */
export function getNodeConfigIssues(
  kind: NodeKind,
  config: Record<string, unknown>,
): string[] {
  const issues: string[] = [];

  switch (kind) {
    case 'inputCsv':
      if (!str(config.path)) issues.push('未选择 CSV 文件');
      break;
    case 'inputExcel':
      if (!str(config.path)) issues.push('未选择 Excel 文件');
      break;
    case 'inputSqlServer':
      if (!str(config.connectionId)) issues.push('未选择数据连接');
      if (!str(config.query)) issues.push('未填写 SQL 查询');
      break;
    case 'select': {
      const fields = list(config.fields);
      const included = fields.filter(
        (item) => item && typeof item === 'object' && (item as { include?: unknown }).include !== false,
      );
      if (fields.length > 0 && included.length === 0) issues.push('未选择任何输出字段');
      break;
    }
    case 'filter':
      if (!str(config.expression)) issues.push('未填写过滤表达式');
      break;
    case 'join':
      if (!str(config.leftKey)) issues.push('未选择左连接键');
      if (!str(config.rightKey)) issues.push('未选择右连接键');
      break;
    case 'aggregation':
      if (list(config.groupBy).length === 0 && list(config.aggregations).length === 0) {
        issues.push('未设置分组字段或聚合函数');
      }
      break;
    case 'sort':
      if (list(config.sorts).length === 0) issues.push('未设置排序字段');
      break;
    case 'formula': {
      const formulas = list(config.formulas);
      if (formulas.length === 0) {
        issues.push('未添加表达式');
      } else if (
        formulas.some((item) => {
          const row = item as { field?: unknown; expression?: unknown } | null;
          return !row || !str(row.field) || !str(row.expression);
        })
      ) {
        issues.push('存在未填写完整的表达式');
      }
      break;
    }
    case 'unique':
      if (list(config.fields).length === 0) issues.push('未选择唯一值字段');
      break;
    case 'runningTotal': {
      const items = list(config.items);
      if (items.length === 0) issues.push('未添加累计字段');
      else if (items.some((item) => !fieldOf(item))) issues.push('累计字段未填写');
      break;
    }
    case 'textToColumns':
      if (!str(config.field)) issues.push('未选择要拆分的字段');
      if (!str(config.delimiter)) issues.push('未设置分隔符');
      break;
    case 'crossTab':
      if (!str(config.headerField)) issues.push('未选择表头字段');
      if (!str(config.valueField)) issues.push('未选择值字段');
      break;
    case 'transpose':
      if (list(config.dataFields).length === 0) issues.push('未选择数据字段');
      break;
    case 'dataModel': {
      const name = str(config.modelName);
      if (!name) issues.push('未填写数据模型名称');
      else if (!MODEL_NAME_RE.test(name)) issues.push('数据模型名称不合法');
      break;
    }
    case 'outputCsv':
    case 'outputExcel':
      if (!str(config.path)) issues.push('未设置输出路径');
      break;
    case 'outputSqlServer':
      if (!str(config.connectionId)) issues.push('未选择数据连接');
      if (!str(config.table)) issues.push('未填写目标表名');
      break;
    default:
      break;
  }

  return issues;
}

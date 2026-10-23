import { api } from '../../../api';
import { buildColumns, coerceRows, dedupeHeaders } from '../lib/columns';
import { uid } from '../lib/utils';
import { parseCsv } from '../lib/csv';
import { parseExcel } from '../lib/xlsx';
import type { Dataset, DatasetDef, QueryResult, SavedDataset } from '../types';

/**
 * 把一次 SQL 查询结果转成数据集（供对话框预览复用，避免二次执行查询）。
 */
export function datasetFromQueryResult(
  name: string,
  connectionId: string,
  query: string,
  result: QueryResult,
): Dataset {
  const headers = dedupeHeaders(result.columns.map((c) => c.name));
  const columns = buildColumns(headers, result.rows);
  const rows = coerceRows(result.rows, columns);
  return {
    id: uid('ds'),
    name,
    source: 'sql',
    columns,
    rows,
    createdAt: new Date().toISOString(),
    def: { kind: 'sql', connectionId, query },
  };
}

export async function querySqlDataset(name: string, connectionId: string, query: string): Promise<Dataset> {
  const result = await api.post<QueryResult>('/api/data/query', {
    body: { connectionId, query },
  });
  return datasetFromQueryResult(name, connectionId, query, result);
}

/** 从已加载的数据模型取数；模型数据已物化在平台内，仅返回列与行。 */
export async function loadModelDataset(name: string, modelName: string): Promise<Dataset> {
  const result = await api.post<QueryResult>('/api/models/query', { body: { name: modelName } });
  const headers = dedupeHeaders(result.columns.map((c) => c.name));
  const columns = buildColumns(headers, result.rows);
  const rows = coerceRows(result.rows, columns);
  return {
    id: uid('ds'),
    name,
    source: 'model',
    columns,
    rows,
    createdAt: new Date().toISOString(),
    def: { kind: 'model', modelName },
  };
}

export async function loadFileDataset(name: string, resourcePath: string): Promise<Dataset> {
  const res = await fetch(`/api/resources/files/download?path=${encodeURIComponent(resourcePath)}`, {
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`读取资源文件失败（${res.status}）`);
  const lower = resourcePath.toLowerCase();
  let def: DatasetDef;
  if (lower.endsWith('.csv')) {
    def = { kind: 'file', resourcePath, format: 'csv' };
    return parseCsv(await res.text(), name, def);
  }
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    def = { kind: 'file', resourcePath, format: 'excel' };
    return parseExcel(new Uint8Array(await res.arrayBuffer()), name, def);
  }
  throw new Error('仅支持 CSV / Excel 文件');
}

/** 打开仪表板时按落库定义重新取数；固定回写 saved.id，保证 widget.datasetId 引用稳定。 */
export async function hydrateDataset(saved: SavedDataset): Promise<Dataset> {
  const ds =
    saved.def.kind === 'sql'
      ? await querySqlDataset(saved.name, saved.def.connectionId, saved.def.query)
      : saved.def.kind === 'model'
        ? await loadModelDataset(saved.name, saved.def.modelName)
        : await loadFileDataset(saved.name, saved.def.resourcePath);
  return { ...ds, id: saved.id, formats: saved.formats };
}

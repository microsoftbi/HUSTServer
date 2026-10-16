import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import XLSX from 'xlsx';
import { afterAll, describe, expect, it } from 'vitest';
import {
  closeSession,
  countRows,
  describeTable,
  loadCsvInto,
  loadExcelInto,
  openModelDb,
  promoteStagingTable,
} from '../src/index.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-engine-model-'));
const dbFile = path.join(tmp, 'models.duckdb');

function writeCsv(name: string, content: string): string {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, content, 'utf-8');
  return file;
}

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('engine 模型加载', () => {
  it('openModelDb + loadCsvInto 建表并返回列与行数', async () => {
    const csv = writeCsv('sales.csv', 'id,name\n1,a\n2,b\n');
    const session = await openModelDb(dbFile);
    try {
      const rowCount = await loadCsvInto(session.connection, 'stg_sales', { path: csv });
      expect(rowCount).toBe(2);
      const cols = await describeTable(session.connection, 'stg_sales');
      expect(cols.map((c) => c.name)).toEqual(['id', 'name']);
    } finally {
      closeSession(session);
    }
  });

  it('promoteStagingTable 原子覆盖同名表并清理 staging', async () => {
    const first = writeCsv('a.csv', 'id,v\n1,a\n2,b\n3,c\n');
    const second = writeCsv('b.csv', 'id,v\n9,z\n');
    const session = await openModelDb(dbFile);
    try {
      await loadCsvInto(session.connection, 'stg_a', { path: first });
      await promoteStagingTable(session.connection, 'sales_model', 'stg_a');
      expect(await countRows(session.connection, 'sales_model')).toBe(3);
      await expect(describeTable(session.connection, 'stg_a')).rejects.toThrow();

      await loadCsvInto(session.connection, 'stg_b', { path: second });
      await promoteStagingTable(session.connection, 'sales_model', 'stg_b');
      expect(await countRows(session.connection, 'sales_model')).toBe(1);
      await expect(describeTable(session.connection, 'stg_b')).rejects.toThrow();
    } finally {
      closeSession(session);
    }
  });

  it('文件库持久化：关闭后重新打开仍能读到模型', async () => {
    const csv = writeCsv('p.csv', 'id\n1\n2\n');
    const s1 = await openModelDb(dbFile);
    await loadCsvInto(s1.connection, 'stg_p', { path: csv });
    await promoteStagingTable(s1.connection, 'persist_model', 'stg_p');
    closeSession(s1);

    const s2 = await openModelDb(dbFile);
    try {
      expect(await countRows(s2.connection, 'persist_model')).toBe(2);
    } finally {
      closeSession(s2);
    }
  });

  it('loadExcelInto 从 xlsx 建表', async () => {
    const xlsxPath = path.join(tmp, 'book.xlsx');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['id', 'name'], [1, 'x'], [2, 'y']]), 'Sheet1');
    XLSX.writeFile(wb, xlsxPath);

    const session = await openModelDb(dbFile);
    try {
      const rowCount = await loadExcelInto(session.connection, 'excel_model', { path: xlsxPath });
      expect(rowCount).toBe(2);
      const cols = await describeTable(session.connection, 'excel_model');
      expect(cols.map((c) => c.name)).toEqual(['id', 'name']);
    } finally {
      closeSession(session);
    }
  });
});

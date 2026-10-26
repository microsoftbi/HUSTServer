// 导出工具：把报表页 / 单个视觉对象渲染成 PNG、PDF，或把聚合数据导出为 CSV。
// 截图依赖 html-to-image，PDF 依赖 jsPDF，均按需动态加载，避免拖累首屏包体。

import type { CellValue } from "@bi/types";

export interface CaptureOptions {
  /** 输出尺寸（未缩放坐标系）；不传时按节点实际尺寸 */
  width?: number;
  height?: number;
  /** 背景色：报表页透明处需显式填充 */
  background?: string;
}

async function captureNode(
  node: HTMLElement,
  options: CaptureOptions = {},
): Promise<{ dataUrl: string; blob: Blob }> {
  const { toPng } = await import("html-to-image");
  const dataUrl = await toPng(node, {
    width: options.width,
    height: options.height,
    backgroundColor: options.background,
    pixelRatio: 2,
    // 页面视图缩放是 CSS transform，导出时取消，按原始尺寸截图
    style: { transform: "none", transformOrigin: "top left", margin: "0" },
    // 编辑辅助元素（缩放手柄、网格线）不进入截图
    filter: (el) =>
      !(el instanceof HTMLElement) || el.dataset.exportHide === undefined,
  });
  const blob = await (await fetch(dataUrl)).blob();
  return { dataUrl, blob };
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** 导出 PNG 并下载。 */
export async function downloadPng(
  node: HTMLElement,
  filename: string,
  options: CaptureOptions = {},
): Promise<void> {
  const { blob } = await captureNode(node, options);
  downloadBlob(blob, filename);
}

/** 导出 PDF 并下载（页面尺寸与报表页一致）。 */
export async function downloadPdf(
  node: HTMLElement,
  filename: string,
  size: { w: number; h: number },
  background?: string,
): Promise<void> {
  const { dataUrl } = await captureNode(node, {
    width: size.w,
    height: size.h,
    background,
  });
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({
    orientation: "portrait",
    unit: "px",
    format: [size.w, size.h],
    compress: true,
  });
  pdf.addImage(dataUrl, "PNG", 0, 0, size.w, size.h);
  pdf.save(filename);
}

/**
 * 把图像写入系统剪贴板。
 * @returns 浏览器不支持或用户拒绝权限时返回 false，由调用方降级为下载。
 */
export async function copyImageToClipboard(
  node: HTMLElement,
  options: CaptureOptions = {},
): Promise<boolean> {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) return false;
  try {
    const { blob } = await captureNode(node, options);
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return true;
  } catch {
    return false;
  }
}

/** 单元格数组 → CSV 文本（RFC 4180 转义）。 */
export function toCsv(headers: string[], rows: CellValue[][]): string {
  const escape = (value: CellValue): string => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headers, ...rows].map((row) => row.map(escape).join(",")).join("\r\n");
}

/** 导出 CSV 并下载（带 BOM，Excel 打开中文不乱码）。 */
export function downloadCsv(
  filename: string,
  headers: string[],
  rows: CellValue[][],
): void {
  const blob = new Blob([`\ufeff${toCsv(headers, rows)}`], {
    type: "text/csv;charset=utf-8",
  });
  downloadBlob(blob, filename);
}

/** 文件名安全的当前时间戳，如 20261026-1530。 */
export function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

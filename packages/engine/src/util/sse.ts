import type { ServerResponse } from 'node:http';
import type { SseEvent } from '../types.js';

/** 初始化 SSE 响应头。 */
export function initSse(res: ServerResponse, origin?: string): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    // 该路由使用 reply.hijack() 直接写响应头，绕过了 @fastify/cors，
    // 故需手动回显 Origin，否则跨域页面（Vite dev 5173）会拦截 EventSource。
    'Access-Control-Allow-Origin': origin ?? '*',
    Vary: 'Origin',
  });
  res.write(': connected\n\n');
}

export function sendSse(res: ServerResponse, event: SseEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function sendSseComment(res: ServerResponse, text: string): void {
  res.write(`: ${text}\n\n`);
}

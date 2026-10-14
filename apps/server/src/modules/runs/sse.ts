import type { SseEvent } from '@hustserver/engine';
import type { FastifyReply } from 'fastify';

/** 接管响应并写入 SSE 头。调用后必须自行 end()。 */
export function openSse(reply: FastifyReply): void {
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  reply.raw.flushHeaders?.();
  reply.raw.write(': connected\n\n');
}

export function writeEvent(reply: FastifyReply, event: string, data: unknown): void {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function endSse(reply: FastifyReply): void {
  reply.raw.end();
}

/** 日志事件无 type 字段，统一命名为 'log'；其余用其 type。 */
export function eventName(event: SseEvent): string {
  return 'type' in event ? event.type : 'log';
}

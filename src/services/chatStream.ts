/**
 * Canal SSE (Server-Sent Events) para o chat aluno-personal.
 *
 * Reutiliza o mesmo padrão de receptionStream.ts:
 * EventEmitter in-process com canal por conversa.
 *
 * Limitação: single-instance apenas. Para multi-instância, substituir pelo
 * padrão Redis Pub/Sub (mesmo REDIS_URL já disponível no redisClient).
 */

import { EventEmitter } from 'events';

const emitter = new EventEmitter();
emitter.setMaxListeners(1000);

function channel(conversationId: number): string {
  return `chat:${conversationId}`;
}

export interface ChatStreamPayload {
  conversationId: number;
  message: {
    id: number;
    sender_id: number;
    sender_role: string;
    text: string;
    created_at: string;
  };
}

export function chatStreamEmit(conversationId: number, payload: ChatStreamPayload): void {
  emitter.emit(channel(conversationId), payload);
}

/** Retorna função de cleanup (unsubscribe). Deve ser chamada no close da conexão SSE. */
export function chatStreamSubscribe(
  conversationId: number,
  listener: (payload: ChatStreamPayload) => void
): () => void {
  const ch = channel(conversationId);
  emitter.on(ch, listener);
  return () => {
    emitter.off(ch, listener);
  };
}

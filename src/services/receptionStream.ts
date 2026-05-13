import { EventEmitter } from 'events';

const emitter = new EventEmitter();
emitter.setMaxListeners(500);

function channel(academyId: number): string {
  return `reception:${academyId}`;
}

export function receptionStreamEmit(academyId: number, payload: unknown): void {
  emitter.emit(channel(academyId), payload);
}

export function receptionStreamSubscribe(
  academyId: number,
  listener: (payload: unknown) => void
): () => void {
  const ch = channel(academyId);
  emitter.on(ch, listener);
  return () => {
    emitter.off(ch, listener);
  };
}

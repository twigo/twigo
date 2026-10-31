import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  Backend,
  MessageOf,
  PlainCommand,
  RequestOf,
  ResponseOf,
  SubscriptionCommand,
} from "./backend";
import { toIpcError } from "./error";

function rethrow(error: unknown): never {
  throw toIpcError(error);
}

export const tauriBackend: Backend = {
  invoke<C extends PlainCommand>(command: C, request: RequestOf<C>) {
    return invoke<ResponseOf<C>>(command, { request }).catch(rethrow);
  },
  subscribe<C extends SubscriptionCommand>(
    command: C,
    request: RequestOf<C>,
    onMessage: (message: MessageOf<C>) => void,
  ) {
    return invoke<ResponseOf<C>>(command, {
      request,
      channel: new Channel(onMessage),
    }).catch(rethrow);
  },
};

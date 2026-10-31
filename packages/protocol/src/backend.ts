import type { Commands } from "./generated";

export type CommandName = keyof Commands;
export type RequestOf<C extends CommandName> = Commands[C]["request"];
export type ResponseOf<C extends CommandName> = Commands[C]["response"];
export type MessageOf<C extends CommandName> = Commands[C]["message"];

/** Commands without a channel. */
export type PlainCommand = {
  [C in CommandName]: MessageOf<C> extends null ? C : never;
}[CommandName];

/** Commands that stream messages over a channel. */
export type SubscriptionCommand = Exclude<CommandName, PlainCommand>;

/** What the webview talks to: Rust through Tauri, or the mock. Both reject with an IpcError. */
export interface Backend {
  invoke<C extends PlainCommand>(
    command: C,
    request: RequestOf<C>,
  ): Promise<ResponseOf<C>>;
  subscribe<C extends SubscriptionCommand>(
    command: C,
    request: RequestOf<C>,
    onMessage: (message: MessageOf<C>) => void,
  ): Promise<ResponseOf<C>>;
}

// Shared UI types: the signed-in user (GET /v1/me), conversation turns and card/panel specs.
import type { components } from '@11e/contracts/web';

export type Me = components['schemas']['Me'];
export type RoleCode = components['schemas']['RoleCode'];

/** A card placed in the conversation. `props` is JSON so the conversation can be kept in sessionStorage. */
export interface CardSpec {
  id: string;
  kind: string;
  props: Record<string, unknown>;
}

export type Block = { type: 'text'; text: string } | { type: 'card'; card: CardSpec };

export type Turn =
  | { id: string; role: 'user'; text: string; at: string }
  | { id: string; role: 'assistant'; blocks: Block[]; at: string };

export interface Conversation {
  id: string;
  title: string;
  turns: Turn[];
  /** insight conversation id, once a chat question was asked (WEB-07). */
  remoteId?: string;
  updatedAt: string;
}

export interface PanelSpec {
  kind: string;
  title: string;
  props?: Record<string, unknown>;
}

/** What a card or panel can do with the shell. */
export interface ShellActions {
  me: Me;
  send: (text: string) => void;
  openPanel: (spec: PanelSpec) => void;
  closePanel: () => void;
  toast: (message: string) => void;
  /** Append cards to the current conversation as an assistant turn (e.g. a follow-up action card). */
  addCards: (cards: Omit<CardSpec, 'id'>[], text?: string) => void;
  can: (permission: string) => boolean;
}

export interface CardProps<P = Record<string, unknown>> {
  spec: CardSpec & { props: P };
  shell: ShellActions;
  /** Persist card state (e.g. "done") into the conversation. */
  patch: (props: Partial<P>) => void;
}

export interface PanelProps<P = Record<string, unknown>> {
  props: P;
  shell: ShellActions;
}

'use client';
// Shell state: conversations (kept per browser tab in sessionStorage), the side panel, toasts and the composer's
// intent routing. Chat questions go to insight (WEB-07); "/" actions and record phrasings open cards and panels.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { onAuthError } from '../lib/api';
import { parseIntent, titleFor } from '../lib/intent';
import { resolveIntent } from '../chat/intents';
import type { Block, CardSpec, Conversation, Me, PanelSpec, ShellActions, Turn } from './types';

const STORAGE_KEY = '11e.conversations.v1';
const MAX_CONVERSATIONS = 30;

interface ShellState extends ShellActions {
  conversations: Conversation[];
  current: Conversation | undefined;
  panel: PanelSpec | null;
  sideOpen: boolean;
  setSideOpen: (open: boolean) => void;
  newChat: () => void;
  patchCard: (conversationId: string, cardId: string, props: Record<string, unknown>) => void;
  toastMessage: string | null;
}

const Ctx = createContext<ShellState | null>(null);

export function useShell(): ShellState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useShell outside ShellProvider');
  return v;
}

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

function load(): Conversation[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Conversation[]) : [];
  } catch {
    return [];
  }
}

export function ShellProvider({ me, children }: { me: Me; children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [panel, setPanel] = useState<PanelSpec | null>(null);
  const [sideOpen, setSideOpen] = useState(false);
  const [toastMessage, setToast] = useState<string | null>(null);
  const loaded = useRef(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    setConversations(load());
    loaded.current = true;
  }, []);
  useEffect(() => {
    if (!loaded.current) return;
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(conversations.slice(0, MAX_CONVERSATIONS)));
    } catch {
      /* storage full or disabled: conversations stay in memory */
    }
  }, [conversations]);
  useEffect(
    () =>
      onAuthError(() => {
        router.replace('/sign-in?reason=session-expired');
      }),
    [router],
  );

  const currentId = pathname?.startsWith('/chat/') ? decodeURIComponent(pathname.slice(6)) : undefined;
  const current = conversations.find((c) => c.id === currentId);

  const toast = useCallback((message: string) => {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }, []);

  const appendTurn = useCallback((conversationId: string, turn: Turn, title?: string) => {
    setConversations((list) => {
      const found = list.find((c) => c.id === conversationId);
      const updated: Conversation = found
        ? { ...found, turns: [...found.turns, turn], updatedAt: now() }
        : { id: conversationId, title: title ?? 'New chat', turns: [turn], updatedAt: now() };
      return [updated, ...list.filter((c) => c.id !== conversationId)];
    });
  }, []);

  const currentRef = useRef<string | undefined>(currentId);
  currentRef.current = currentId;

  const addCardsTo = useCallback(
    (conversationId: string, cards: Omit<CardSpec, 'id'>[], text?: string) => {
      const blocks: Block[] = [
        ...(text ? [{ type: 'text' as const, text }] : []),
        ...cards.map((c) => ({ type: 'card' as const, card: { ...c, id: uid() } })),
      ];
      appendTurn(conversationId, { id: uid(), role: 'assistant', blocks, at: now() });
    },
    [appendTurn],
  );

  const can = useCallback((p: string) => me.permissions.includes(p), [me.permissions]);

  const send = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (!text) return;
      let conversationId = currentRef.current;
      if (!conversationId) {
        conversationId = uid();
        router.push(`/chat/${conversationId}`);
      }
      currentRef.current = conversationId;
      appendTurn(conversationId, { id: uid(), role: 'user', text, at: now() }, titleFor(text));
      const result = resolveIntent(parseIntent(text), { me, conversationId });
      if (result.panel) setPanel(result.panel);
      if (result.cards.length || result.text) addCardsTo(conversationId, result.cards, result.text);
      setSideOpen(false);
    },
    [addCardsTo, appendTurn, me, router],
  );

  const actions = useMemo<ShellActions>(
    () => ({
      me,
      send,
      openPanel: (spec) => setPanel(spec),
      closePanel: () => setPanel(null),
      toast,
      can,
      addCards: (cards, text) => {
        const id = currentRef.current;
        if (id) addCardsTo(id, cards, text);
      },
    }),
    [addCardsTo, can, me, send, toast],
  );

  const patchCard = useCallback((conversationId: string, cardId: string, props: Record<string, unknown>) => {
    setConversations((list) =>
      list.map((c) =>
        c.id !== conversationId
          ? c
          : {
              ...c,
              turns: c.turns.map((t) =>
                t.role !== 'assistant'
                  ? t
                  : {
                      ...t,
                      blocks: t.blocks.map((b) =>
                        b.type === 'card' && b.card.id === cardId
                          ? { ...b, card: { ...b.card, props: { ...b.card.props, ...props } } }
                          : b,
                      ),
                    },
              ),
            },
      ),
    );
  }, []);

  const value: ShellState = {
    ...actions,
    conversations,
    current,
    panel,
    sideOpen,
    setSideOpen,
    newChat: () => {
      setPanel(null);
      setSideOpen(false);
      router.push('/');
    },
    patchCard,
    toastMessage,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

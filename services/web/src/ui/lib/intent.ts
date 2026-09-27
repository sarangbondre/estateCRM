// What the composer understands without the AI (pure, no React): "/" quick actions (PRD §5.1, prototype SLASH list)
// and a few deterministic phrasings around record codes ("open INV-00452", "publish INV-00488", "qualify DEM-000127").
// Anything else is a chat question for insight (R-CHAT-1: nothing changes until a person clicks a card button).

export type Intent =
  | { kind: 'queue' }
  | { kind: 'desks' }
  | { kind: 'quick-add'; side: 'Demand' | 'Supply'; text?: string }
  | { kind: 'add-supply'; demand?: string }
  | { kind: 'matches'; demand?: string }
  | { kind: 'upload' }
  | { kind: 'review' }
  | { kind: 'dashboard' }
  | { kind: 'exports' }
  | { kind: 'open'; code: string }
  | { kind: 'publish'; code: string }
  | { kind: 'qualify'; code: string }
  | { kind: 'call'; code: string; text: string }
  | { kind: 'sourcing'; code: string }
  | { kind: 'proposal'; code: string }
  | { kind: 'visit'; code?: string }
  | { kind: 'deal'; demand: string; offer?: string }
  | { kind: 'exit'; code: string; text: string }
  | { kind: 'retire'; code: string }
  | { kind: 'ask'; text: string };

export interface SlashAction {
  command: string;
  label: string;
}

/** The "/" menu, in the prototype's order (docs/prototype, SLASH). */
export const SLASH_ACTIONS: readonly SlashAction[] = [
  { command: '/queue', label: 'My queue' },
  { command: '/desks', label: 'Business / Capital desks, Network, Watchlist' },
  { command: '/add demand', label: 'Quick add a requirement (phone first)' },
  { command: '/add supply', label: 'Add supply' },
  { command: '/matches', label: 'Matches to confirm' },
  { command: '/upload', label: 'Upload a sheet' },
  { command: '/review', label: 'Review uncertain merges and unclear rows' },
  { command: '/dashboard', label: 'Dashboards' },
  { command: '/exports', label: 'My exports' },
];

/** Menu entries for the current draft: shown while the draft starts with "/" and its first word is a prefix. */
export function slashSuggestions(draft: string): SlashAction[] {
  if (!draft.startsWith('/')) return [];
  const typed = draft.trim().toLowerCase();
  if (typed === '/') return [...SLASH_ACTIONS];
  return SLASH_ACTIONS.filter((a) => a.command.startsWith(typed) || typed.startsWith(`${a.command} `));
}

const CODE = /\b((?:INV|DEM|PRP|PRJ|PER|ENQ|SRQ|PROP|VIS|DEAL|BIZ|CAP|EQP|WCH|UPL|EXP|MAT|BND)-\d{2,})\b/gi;

/** Record codes mentioned in a text, upper-cased, in order. */
export function codesIn(text: string): string[] {
  return [...text.matchAll(CODE)].map((m) => (m[1] ?? '').toUpperCase());
}

const first = (codes: string[], prefix: string) => codes.find((c) => c.startsWith(`${prefix}-`));

export function parseIntent(input: string): Intent {
  const text = input.trim();
  const lower = text.toLowerCase();
  const codes = codesIn(text);
  const inv = first(codes, 'INV');
  const dem = first(codes, 'DEM');

  if (lower.startsWith('/')) {
    const [cmd = '', ...rest] = lower.split(/\s+/);
    const arg = rest.join(' ');
    switch (cmd) {
      case '/queue':
        return { kind: 'queue' };
      case '/desks':
        return { kind: 'desks' };
      case '/add':
        if (arg.startsWith('supply'))
          return dem ? { kind: 'add-supply', demand: dem } : { kind: 'add-supply' };
        return { kind: 'quick-add', side: arg.startsWith('demand') || !arg ? 'Demand' : 'Supply' };
      case '/matches':
        return dem ? { kind: 'matches', demand: dem } : { kind: 'matches' };
      case '/upload':
        return { kind: 'upload' };
      case '/review':
        return { kind: 'review' };
      case '/dashboard':
      case '/dashboards':
        return { kind: 'dashboard' };
      case '/exports':
        return { kind: 'exports' };
      case '/open':
        if (codes[0]) return { kind: 'open', code: codes[0] };
        break;
    }
    return { kind: 'ask', text };
  }

  if (/^(open|show)\b/.test(lower) && codes.length === 1 && codes[0]) return { kind: 'open', code: codes[0] };
  if (/^publish\b/.test(lower) && inv) return { kind: 'publish', code: inv };
  if (/^qualify\b/.test(lower) && dem) return { kind: 'qualify', code: dem };
  if (/^(called|call|spoke|talked)\b/.test(lower) && (inv || dem))
    return { kind: 'call', code: (inv ?? dem) as string, text };
  if (/\bsource (supply )?for\b/.test(lower) && dem) return { kind: 'sourcing', code: dem };
  if (/\badd supply for\b/.test(lower) && dem) return { kind: 'add-supply', demand: dem };
  if (/\b(send|make|create) (a )?proposal\b/.test(lower) && dem) return { kind: 'proposal', code: dem };
  if (/\b(schedule|book) (a )?(site )?visit\b/.test(lower))
    return dem ? { kind: 'visit', code: dem } : { kind: 'visit' };
  if (/\bstart (a )?deal\b/.test(lower) && dem)
    return inv ? { kind: 'deal', demand: dem, offer: inv } : { kind: 'deal', demand: dem };
  if (/\b(postponed|lost|invalid|dormant|mark .* lost)\b/.test(lower) && dem)
    return { kind: 'exit', code: dem, text };
  if (/\b(is gone|retire|inactive|sold out|rented out)\b/.test(lower) && inv)
    return { kind: 'retire', code: inv };
  if (/\bmatch(es)?\b/.test(lower) && dem) return { kind: 'matches', demand: dem };
  if (
    /^(new requirement|needs|wants)\b/.test(lower) ||
    /\bneeds (an? )?(office|flat|shop|warehouse|apartment)\b/.test(lower)
  )
    return { kind: 'quick-add', side: 'Demand', text };
  return { kind: 'ask', text };
}

/** Short conversation title from the first message (prototype titleFor). */
export function titleFor(text: string): string {
  const t = text.replace(/^\//, '').trim();
  return t.length > 46 ? `${t.slice(0, 45)}…` : t;
}

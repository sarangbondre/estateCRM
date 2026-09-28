// Words of business questions that the redactor must never take for a person's name after a contact cue ("each
// supply agent verify this week" would otherwise mask "verify" / "week"). Together with localities and vocabulary
// values they are the chat's allow-list (LLD §4.1 step 1). Names are still masked after cues ("call Sanjay").
export const CHAT_ALLOW_TERMS: readonly string[] = [
  // question words and function words
  'how', 'many', 'much', 'what', 'which', 'who', 'when', 'where', 'why', 'is', 'are', 'was', 'were', 'did', 'do', 'does',
  'has', 'have', 'had', 'the', 'a', 'an', 'this', 'that', 'these', 'those', 'my', 'our', 'your', 'each', 'every', 'all',
  'any', 'per', 'with', 'for', 'in', 'on', 'of', 'to', 'from', 'by', 'and', 'or', 'more', 'less', 'than', 'above',
  'below', 'under', 'over', 'most', 'least', 'top', 'about', 'today', 'yesterday', 'tomorrow', 'week', 'weeks',
  'month', 'months', 'quarter', 'year', 'days', 'day', 'last', 'next', 'please', 'me', 'us', 'we', 'it', 'they',
  // verbs of the business
  'verify', 'verified', 'verifies', 'call', 'called', 'calls', 'calling', 'close', 'closed', 'closes', 'qualify',
  'qualified', 'confirm', 'confirmed', 'log', 'logged', 'add', 'added', 'upload', 'uploaded', 'uploads', 'match',
  'matched', 'matches', 'list', 'show', 'give', 'find', 'count', 'export', 'download', 'open', 'publish', 'published',
  'source', 'sourced', 'sourcing', 'assign', 'assigned', 'visit', 'visited', 'visits', 'propose', 'proposed',
  // nouns of the business
  'offer', 'offers', 'demand', 'demands', 'deal', 'deals', 'listing', 'listings', 'lead', 'leads', 'requirement',
  'requirements', 'property', 'properties', 'project', 'projects', 'client', 'clients', 'owner', 'owners', 'agent',
  'agents', 'team', 'queue', 'follow-ups', 'follow-up', 'followups', 'proposal', 'proposals', 'bundle', 'bundles',
  'overdue', 'pending', 'active', 'available', 'suggested', 'fresh', 'stale', 'ageing', 'expired', 'upcoming', 'excel',
];

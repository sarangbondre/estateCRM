-- Share-link hint shown on the proposal card (Proposal.activeLink.urlHint): the first characters of the token only.
alter table proposal_links add column if not exists url_hint text;

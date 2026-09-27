// intake cards (C-04 upload, C-05 review; PRD §5.4). Registered by ../all.ts.
import { defineCard } from '../registry';
import type { AnyCard, AnyPanel } from '../registry';
import { ReviewCard } from './ReviewCard';
import { UploadCard } from './UploadCard';

export const cards: Record<string, AnyCard> = {
  upload: defineCard(UploadCard),
  review: defineCard(ReviewCard),
};
export const panels: Record<string, AnyPanel> = {};

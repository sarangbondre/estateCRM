// Every card and panel the conversation can show (PRD §5.4). Imported once by the shell.
import { registerCards, registerPanels } from './registry';
import * as intake from './intake';
import * as records from './records';
import * as journeys from './journeys';
import * as engine from './engine';
import * as listings from './listings';
import * as insight from './insight';

for (const area of [intake, records, journeys, engine, listings, insight]) {
  registerCards(area.cards);
  registerPanels(area.panels);
}

// Props every settings tab receives.
import type { ShellActions } from '../shell/types';

export interface TabProps {
  shell: ShellActions;
  /** The signed-in role may change what this tab shows. */
  editable: boolean;
}

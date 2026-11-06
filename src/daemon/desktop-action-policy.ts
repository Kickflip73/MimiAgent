import { ActionFailedSafeError } from '../core/action-intent.js';

const GUI_WRITES = new Set([
  'activate_app', 'open_item', 'open_visible', 'launch_app', 'bring_to_front',
  'keyboard_type', 'keyboard_key', 'send_keys', 'keypress', 'type_text', 'set_value',
  'click_menu', 'click', 'double_click', 'drag', 'scroll', 'move_cursor',
]);

export function isGenericDesktopWrite(action: { name: string; capability?: string; effect?: string }): boolean {
  // Names cover legacy/mislabelled registrations; namespace covers renamed actions.
  return GUI_WRITES.has(action.name)
    || (/^desktop\.(?:app|window|keyboard|mouse|ui)(?:\.|$)/u.test(action.capability ?? '') && action.effect !== 'read');
}

export function assertComputerRoute(action: { name: string; capability?: string; effect?: string }): void {
  if (isGenericDesktopWrite(action)) {
    throw new ActionFailedSafeError('computer_route_required：通用 GUI 写操作只能通过 computer_act 的目标绑定、权限和副作用账本执行');
  }
}

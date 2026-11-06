import { ActionFailedSafeError } from '../../core/action-intent.js';

const aliases: Record<string, string> = {
  command: 'cmd', meta: 'cmd', super: 'cmd', control: 'ctrl', option: 'alt',
  enter: 'return', esc: 'escape', backspace: 'delete',
  left_arrow: 'left', right_arrow: 'right', up_arrow: 'up', down_arrow: 'down',
};
const modifiers = new Set(['cmd', 'shift', 'alt', 'ctrl', 'fn']);
const namedKeys = new Set([
  'return', 'tab', 'space', 'delete', 'escape', 'capslock', 'home', 'end',
  'pageup', 'pagedown', 'del', 'forward_delete', 'left', 'right', 'up', 'down', 'plus',
]);

/** One chord, never a sequence of independent keys. Validate before any driver call. */
export function normalizeComputerKeys(input: string[]): string[] {
  const chord = input.length === 1 ? input[0]?.trim() : undefined;
  const parts = chord && chord !== '+' && chord.includes('+')
    ? (chord.endsWith('++') ? [...chord.slice(0, -2).split('+'), '+'] : chord.split('+'))
    : input;
  const keys = parts.map(value => {
    const key = value.trim().toLowerCase();
    return aliases[key] ?? key;
  });
  const validKey = (key: string) => modifiers.has(key) || namedKeys.has(key)
    || /^[a-z0-9=\-\[\]'\\,/.`;+]$/.test(key) || /^f(?:[1-9]|1[0-2])$/.test(key);
  if (!keys.length || keys.length > 5 || keys.some(key => !validKey(key))
    || (keys.length > 1 && (keys.slice(0, -1).some(key => !modifiers.has(key)) || modifiers.has(keys.at(-1)!)))) {
    throw new ActionFailedSafeError('invalid_keys：每次只能发送一个按键或组合键，例如 ["cmd","a"]、["cmd+a"]、["Enter"]；未投递。文本请用 type_text。');
  }
  return keys;
}

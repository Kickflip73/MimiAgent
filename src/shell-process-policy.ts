type ShellToken = { text: string; operator: boolean };

/** Static ownership check, not a shell sandbox. Process-group cleanup remains mandatory.
 * Only executable shell syntax is inspected: quoted arguments and here-doc data are
 * literals, but command substitutions and explicit shell -c/eval bodies execute code.
 */
export function hasUnmanagedShellProcess(source: string, depth = 0, expansionsOnly = false): boolean {
  if (depth > 32) return true;
  let offset = 0;
  let denied = false;
  let nesting = depth;
  const isShell = (value: string): boolean => /^(?:ba|da|k|z)?sh$/u.test(value.split('/').at(-1) ?? '');
  const expansion = (): boolean => {
    if (source.startsWith('$(', offset)) {
      offset += 2;
      scan(')');
      return true;
    }
    if (source[offset] === '`') {
      offset += 1;
      scan('`');
      return true;
    }
    return false;
  };
  const scan = (end?: string): void => {
    if (++nesting > 32) { denied = true; return; }
    const tokens: ShellToken[] = [];
    const heredocs: Array<{ delimiter: string; quoted: boolean; tabs: boolean }> = [];
    let heredoc: string | undefined;
    while (offset < source.length && !denied) {
      const char = source[offset]!;
      if (char === end) { offset += 1; break; }
      if (char === '#') {
        while (offset < source.length && source[offset] !== '\n') offset += 1;
        continue;
      }
      if (/\s/u.test(char)) {
        offset += 1;
        if (char === '\n') {
          tokens.push({ text: ';', operator: true });
          for (const doc of heredocs.splice(0)) {
            const start = offset;
            while (offset < source.length) {
              const next = source.indexOf('\n', offset);
              const lineEnd = next < 0 ? source.length : next;
              const line = source.slice(offset, lineEnd);
              if ((doc.tabs ? line.replace(/^\t+/u, '') : line) === doc.delimiter) {
                const shellInput = tokens.some(token => !token.operator && isShell(token.text));
                if (shellInput || !doc.quoted) denied ||= hasUnmanagedShellProcess(source.slice(start, offset), depth + 1, !shellInput);
                offset = next < 0 ? source.length : next + 1;
                break;
              }
              offset = next < 0 ? source.length : next + 1;
            }
          }
        }
        continue;
      }
      if (char === '(') { offset += 1; scan(')'); tokens.push({ text: ';', operator: true }); continue; }
      const operator = source.slice(offset).match(/^(?:&&|\|\||&>>|&>|[<>]&|<<<|<<-?|>>|&[!|]|[;&|<>])/u)?.[0];
      if (operator) {
        tokens.push({ text: operator, operator: true });
        offset += operator.length;
        if (operator === '<<' || operator === '<<-') heredoc = operator;
        continue;
      }
      let word = '';
      let quoted = false;
      while (offset < source.length) {
        const current = source[offset]!;
        if (current === end || /[\s;&|<>()]/u.test(current)) break;
        if (current === '\\') {
          quoted = true;
          offset += 1;
          if (source[offset] !== '\n') word += source[offset] ?? '';
          offset += 1;
        } else if (current === "'" || current === '"') {
          quoted = true;
          const quote = current;
          offset += 1;
          while (offset < source.length && source[offset] !== quote) {
            if (quote === '"' && expansion()) { word += '?'; continue; }
            if (quote === '"' && source[offset] === '\\' && /[$`"\\\n]/u.test(source[offset + 1] ?? '')) {
              offset += 1;
              if (source[offset] !== '\n') word += source[offset];
              offset += 1;
            } else word += source[offset++];
          }
          if (source[offset] === quote) offset += 1;
        } else if (expansion()) word += '?';
        else word += source[offset++];
      }
      // A closing parenthesis outside our current scope is invalid syntax; leave
      // validation to the shell while always advancing the scanner.
      if (!word && !quoted && source[offset] === ')') offset += 1;
      tokens.push({ text: word, operator: false });
      if (heredoc) {
        heredocs.push({ delimiter: word, quoted, tabs: heredoc === '<<-' });
        heredoc = undefined;
      }
    }
    let command: string[] = [];
    const checkCommand = (): void => {
      while (command.length) {
        if (/^[A-Za-z_][A-Za-z_0-9]*=/u.test(command[0]!)
          || ['if', 'then', 'else', 'do', 'while', 'until', 'time', '!', '{'].includes(command[0]!)) { command.shift(); continue; }
        if (!['command', 'exec', 'env', 'builtin'].includes(command[0]!.split('/').at(-1)!)) break;
        command.shift();
        while (command[0]?.startsWith('-')) {
          const flag = command.shift();
          if (flag === '-u' || flag === '--unset') command.shift();
        }
      }
      const executable = command[0]?.split('/').at(-1);
      if (executable && ['nohup', 'disown', 'setsid'].includes(executable)) denied = true;
      if (executable === 'eval') denied ||= hasUnmanagedShellProcess(command.slice(1).join(' '), depth + 1);
      if (executable && isShell(executable)) {
        const flag = command.findIndex((value, index) => index > 0 && /^-[a-z]*c[a-z]*$/u.test(value));
        if (flag > 0 && command[flag + 1]) denied ||= hasUnmanagedShellProcess(command[flag + 1]!, depth + 1);
      }
      command = [];
    };
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i]!;
      if (!token.operator) { command.push(token.text); continue; }
      if (['&!', '&|'].includes(token.text)) denied = true;
      if (token.text === '&' && (!tokens[i + 1] || tokens.slice(i + 1).every(next => next.text === '}' || (next.operator && next.text === ';')))) denied = true;
      if (token.text === '<<<' && command.some(isShell) && tokens[i + 1]) denied ||= hasUnmanagedShellProcess(tokens[i + 1]!.text, depth + 1);
      if (/^[<>]|^&>/u.test(token.text)) {
        if (/^\d+$/u.test(command.at(-1) ?? '')) command.pop();
        if (!tokens[i + 1]?.operator) i += 1;
        continue;
      }
      if ([';', '&', '&&', '|', '||', '&!', '&|'].includes(token.text)) checkCommand();
    }
    checkCommand();
    nesting -= 1;
  };
  if (expansionsOnly) {
    while (offset < source.length && !denied) {
      if (source[offset] === '\\') offset += 2;
      else if (!expansion()) offset += 1;
    }
  } else scan();
  return denied;
}

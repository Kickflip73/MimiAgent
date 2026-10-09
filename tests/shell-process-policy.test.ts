import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runShellCommand } from '../src/tools.js';

test('Shell accepts literal HTML entities, escaped ampersands and quoted shell vocabulary', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-shell-literals-'));
  try {
    for (const [command, expected] of [
      [String.raw`printf '%s' '&lt;A&gt; &amp; &#39; &quot;' | sed 's/&lt;/</g; s/&gt;/>/g; s/&amp;/\&/g; s/&#39;/'"'"'/g; s/&quot;/"/g' | tr -s ' \n' ' \n'`, `<A> & ' "`],
      [String.raw`printf '%s' \&`, '&'],
      [String.raw`printf '%s' "&"`, '&'],
      [String.raw`printf '%s' 'nohup disown setsid &'`, 'nohup disown setsid &'],
      [String.raw`printf '%s' '$(printf ok &)'`, '$(printf ok &)'],
      [String.raw`printf '%s' "$((1 & 3))"`, '1'],
      ["printf ok # comment containing & and nohup", 'ok'],
      ["printf ok && printf done", 'okdone'],
      ["printf ok 1>&2", ''],
      ["cat <<'EOF'\nnohup &#39; &\nEOF", 'nohup &#39; &\n'],
    ]) {
      const result = await runShellCommand(root, command!, 5);
      assert.equal(result.exitCode, 0, `${command}: ${result.stderr}`);
      assert.equal(result.stdout, expected);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Shell refuses detach operators in executable nested shell contexts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-shell-nested-'));
  try {
    for (const command of [
      'printf ok &', 'printf ok & # comment', '(printf ok &)',
      'printf "%s" "$(printf ok &)"', 'printf "%s" "`printf ok &`"',
      "sh -c 'printf ok &'", 'sh -c "no\\hup true"',
      "eval 'printf ok &'", 'no"hup" true', '/usr/bin/nohup true',
      'printf ok &!', 'printf ok &|', 'printf ok & disown',
      '{ printf ok & }', 'if true; then nohup true; fi',
      '>/dev/null nohup true', 'env -i nohup true', 'command -- nohup true',
      "sh <<'EOF'\nnohup true\nEOF", "sh <<< 'printf ok &'",
      "cat <<EOF\n$(nohup true)\nEOF",
    ]) {
      const result = await runShellCommand(root, command, 5);
      assert.equal(result.exitCode, 1, command);
      assert.match(result.stderr, /不允许创建脱离/, command);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

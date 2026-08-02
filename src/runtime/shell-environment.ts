import path from 'node:path';

const SAFE_ENVIRONMENT_NAMES = new Set([
  'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'SHELL', 'USER', 'LOGNAME', 'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR',
  'TZ', 'CI',
  'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'USERPROFILE',
]);

/** Keep only non-sensitive environment variables that a model-authored process
 * may inherit. Provider and control credentials remain in the Host process. */
export function filterShellEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([name]) => (
    SAFE_ENVIRONMENT_NAMES.has(name.toUpperCase()) || name.toUpperCase().startsWith('LC_')
  )));
}

/** Environment for the main Agent Shell. User CLI runtime directories are
 * explicit because launchd does not inherit the interactive shell PATH. */
export function restrictedShellEnvironment(
  source: NodeJS.ProcessEnv,
  runtimeExecutable = process.execPath,
): NodeJS.ProcessEnv {
  const environment = filterShellEnvironment(source);
  const homeDirectory = source.HOME?.trim() || source.USERPROFILE?.trim();
  const executableDirectories = [
    path.dirname(runtimeExecutable),
    ...(homeDirectory ? [
      path.join(homeDirectory, '.local', 'bin'),
      path.join(homeDirectory, '.bun', 'bin'),
    ] : []),
    ...(source.PATH ?? '').split(path.delimiter),
  ].filter(Boolean);
  environment.PATH = [...new Set(executableDirectories)].join(path.delimiter);
  return environment;
}

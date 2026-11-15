// Existing folder paths are stored as "Course / Subfolder" on every notebook.
export const FOLDER_SEP = ' / ';
export const folderName = (path: string) => path.split(FOLDER_SEP).at(-1) ?? '';
export const folderParent = (path: string) => path.split(FOLDER_SEP).slice(0, -1).join(FOLDER_SEP);
export const folderContains = (parent: string, path: string) => path === parent || (!!parent && path.startsWith(parent + FOLDER_SEP));
export const joinFolder = (parent: string, name: string) => parent && name ? parent + FOLDER_SEP + name : parent || name;

/** Include implicit parents, including after sync from an older app version. */
export function folderPaths(paths: string[]): string[] {
  const result = new Set<string>();
  for (const path of paths) {
    if (!path) continue;
    const parts = path.split(FOLDER_SEP);
    for (let i = 1; i <= parts.length; i++) result.add(parts.slice(0, i).join(FOLDER_SEP));
  }
  return [...result];
}

export function folderTarget(parent: string, name: string): string {
  name = name.trim();
  if (!name || name === '.' || name === '..' || /[/\\\u0000-\u001f]/.test(name)) throw new Error('Choose a folder name without slashes.');
  return joinFolder(parent, name);
}

/** Plan a whole subtree move/rename. Never merge folders or allow a cycle. */
export function folderRemap(paths: string[], from: string, to: string): Map<string, string> {
  if (!from || !to) throw new Error('Choose a folder.');
  if (from === to) return new Map();
  if (folderContains(from, to)) throw new Error('A folder cannot be moved inside itself.');
  const all = folderPaths(paths);
  if (!all.includes(from)) throw new Error('That folder no longer exists.');
  if (all.includes(to)) throw new Error('A folder with that name already exists here.');
  return new Map(all.filter((path) => folderContains(from, path)).map((path) => [path, to + path.slice(from.length)]));
}

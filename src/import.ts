import { readZip } from './unzip';

export interface PdfSource { name: string; dir: string; sourceId?: string; data(): Promise<ArrayBuffer>; onImported?(): Promise<void> }
export interface ImportFile { file: File; path: string }

export function cleanImportPath(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter((part) => part && part !== '.' && part !== '..').join('/');
}

export function importTitle(name: string): string {
  return name.replace(/\.pdf$/i, '').replace(/\s+-\s+Goodnotes(?:\s+-\s+.*)?$/i, '').trim() || 'Imported PDF';
}

/** Strip the chosen export's wrapper folder, while keeping its actual subfolders. */
export function importFolders(sources: PdfSource[]): string[] {
  const dirs = sources.map((s) => cleanImportPath(s.dir).split('/').filter(Boolean));
  // A single folder is useful information; don't flatten an export just because all PDFs share it.
  let common = 0;
  while (dirs.length > 1 && dirs.every((d) => d.length > common + 1 && d[common] === dirs[0][common])) common++;
  // A local migration source already supplies its actual folder path, not an export wrapper.
  return dirs.map((d, i) => d.slice(sources[i].sourceId ? 0 : common).join(' / '));
}

export async function pdfHash(data: ArrayBuffer): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Walk PDF exports, including ZIPs nested in exported folders. Native Goodnotes documents aren't PDFs. */
export async function collectPdfSources(file: Blob, path: string, depth = 0): Promise<{ sources: PdfSource[]; unsupported: number }> {
  const clean = cleanImportPath(path);
  const parts = clean.split('/');
  const name = parts.pop() || '';
  if (parts.includes('__MACOSX') || parts.some((p) => p.startsWith('.')) || name.startsWith('.')) return { sources: [], unsupported: 0 };
  if (/\.pdf$/i.test(name)) return { sources: [{ name, dir: parts.join('/'), data: () => file.arrayBuffer() }], unsupported: 0 };
  if (/\.goodnotes$/i.test(name)) return { sources: [], unsupported: 1 };
  if (!/\.zip$/i.test(name)) return { sources: [], unsupported: 0 };
  if (depth >= 4) throw new Error('This export contains too many nested ZIP files. Extract it and import the folder instead.');
  const sources: PdfSource[] = [];
  let unsupported = 0;
  const entries = await readZip(file);
  if (entries.length > 20000) throw new Error('This archive is too large to import at once. Extract it and import smaller folders.');
  for (const entry of entries) {
    const entryPath = cleanImportPath([...parts, entry.name].join('/'));
    const base = entryPath.split('/').pop() || '';
    if (entryPath.split('/').some((p) => p === '__MACOSX' || p.startsWith('.'))) continue;
    if (/\.pdf$/i.test(base)) sources.push({ name: base, dir: entryPath.split('/').slice(0, -1).join('/'), data: () => entry.data() });
    else if (/\.goodnotes$/i.test(base)) unsupported++;
    else if (/\.zip$/i.test(base)) {
      const nested = await collectPdfSources(new Blob([await entry.data()]), entryPath, depth + 1);
      sources.push(...nested.sources); unsupported += nested.unsupported;
    }
  }
  return { sources, unsupported };
}

export async function directoryFiles(handle: any, prefix = ''): Promise<ImportFile[]> {
  const files: ImportFile[] = [];
  for await (const entry of handle.values()) {
    if (entry.name.startsWith('.') || entry.name === '__MACOSX') continue;
    const path = prefix + entry.name;
    if (entry.kind === 'directory') files.push(...await directoryFiles(entry, path + '/'));
    else if (/\.pdf$/i.test(entry.name)) files.push({ file: await entry.getFile(), path });
  }
  return files;
}

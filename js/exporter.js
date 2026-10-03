// Saves each output as its own file: straight into a chosen folder where the
// File System Access API exists (Chrome/Edge), otherwise as individual downloads.

export const canPickFolder = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

class FolderSaver {
  constructor(dir) { this.dir = dir; }

  async exists(name) {
    try { await this.dir.getFileHandle(name); return true; } catch { return false; }
  }

  // Never overwrite: name.jpg -> name (1).jpg -> name (2).jpg ...
  async uniqueName(name) {
    if (!(await this.exists(name))) return name;
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 1; ; i++) {
      const candidate = `${stem} (${i})${ext}`;
      if (!(await this.exists(candidate))) return candidate;
    }
  }

  async save(name, blob) {
    const finalName = await this.uniqueName(name);
    const handle = await this.dir.getFileHandle(finalName, { create: true });
    const w = await handle.createWritable();
    await w.write(blob);
    await w.close();
    return finalName;
  }
}

class DownloadSaver {
  constructor() { this.used = new Set(); }

  uniqueName(name) {
    if (!this.used.has(name)) { this.used.add(name); return name; }
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 1; ; i++) {
      const c = `${stem} (${i})${ext}`;
      if (!this.used.has(c)) { this.used.add(c); return c; }
    }
  }

  async save(name, blob) {
    const finalName = this.uniqueName(name);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = finalName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    // Browsers drop downloads fired too quickly in a row.
    await new Promise(r => setTimeout(r, 300));
    return finalName;
  }
}

// Must be called from a user gesture (the folder picker requires it).
export async function createSaver(target) {
  if (target === 'folder' && canPickFolder) {
    const dir = await window.showDirectoryPicker({ id: 'photoworks-out', mode: 'readwrite' });
    return new FolderSaver(dir);
  }
  return new DownloadSaver();
}

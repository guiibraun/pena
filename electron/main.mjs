// Pena desktop app: the same server + editor inside an Electron window, with native menus
// (like pen.dev's File/Edit/View/Export menus). Agents still run on your Claude/ChatGPT subscriptions.
import { app, BrowserWindow, Menu, dialog, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { start, open, currentFile } from '../server.mjs';
import { recents } from '../library.mjs';

const recent = () => recents().map((r) => r.path).slice(0, 10);

let win, baseUrl;
const openFile = (file) => {
  open(file);
  app.addRecentDocument(currentFile());
  win?.setTitle(`${path.basename(currentFile())} — Pena`);
  win?.loadURL(`${baseUrl}/`);
  buildMenu();
};
const dashboard = () => (win.setTitle('Pena'), win.loadURL(`${baseUrl}/dashboard`));

const pen = { filters: [{ name: 'Pen design', extensions: ['pen'] }] };
async function newFile() {
  const r = await dialog.showSaveDialog(win, { ...pen, defaultPath: path.join(app.getPath('documents'), 'Sem título.pen') });
  if (!r.canceled) openFile(r.filePath);
}
async function openDialog() {
  const r = await dialog.showOpenDialog(win, { ...pen, properties: ['openFile'] });
  if (!r.canceled) openFile(r.filePaths[0]);
}
async function saveAs() {
  const r = await dialog.showSaveDialog(win, { ...pen, defaultPath: currentFile() });
  if (r.canceled) return;
  fs.copyFileSync(currentFile(), r.filePath);
  const images = path.join(path.dirname(currentFile()), 'images');
  if (fs.existsSync(images) && path.dirname(r.filePath) !== path.dirname(currentFile()))
    fs.cpSync(images, path.join(path.dirname(r.filePath), 'images'), { recursive: true }); // keep relative image fills working
  openFile(r.filePath);
}
async function exportSelection(format) {
  try {
    const { data, name } = await win.webContents.executeJavaScript(`window.pena.exportSelection(${JSON.stringify(format)})`);
    const ext = format === 'html-css' ? 'html' : format;
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(path.dirname(currentFile()), `${name}.${ext}`) });
    if (r.canceled) return;
    fs.writeFileSync(r.filePath, data.startsWith('data:') ? Buffer.from(data.split(',')[1], 'base64') : data);
    shell.showItemInFolder(r.filePath);
  } catch (e) {
    dialog.showErrorBox('Exportar', String(e.message ?? e));
  }
}
async function importImage() {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Imagens', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'] }] });
  for (const f of r.canceled ? [] : r.filePaths)
    await win.webContents.executeJavaScript(`window.pena.importImage(${JSON.stringify([...fs.readFileSync(f)])}, ${JSON.stringify(path.basename(f))})`);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const recents = recent();
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac
        ? [{
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { label: 'Configurações…', accelerator: 'CmdOrCtrl+,', click: () => win?.webContents.executeJavaScript('window.penaSettings?.()') },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          }]
        : []),
      {
        label: 'Arquivo',
        submenu: [
          { label: 'Dashboard', accelerator: 'CmdOrCtrl+Shift+D', click: dashboard },
          { type: 'separator' },
          { label: 'Novo arquivo…', accelerator: 'CmdOrCtrl+N', click: newFile },
          { label: 'Abrir…', accelerator: 'CmdOrCtrl+O', click: openDialog },
          {
            label: 'Abrir recente',
            submenu: recents.length
              ? recents.map((f) => ({ label: f, click: () => openFile(f) }))
              : [{ label: 'Nenhum arquivo recente', enabled: false }],
          },
          { type: 'separator' },
          { label: 'Salvar como…', accelerator: 'CmdOrCtrl+Shift+S', click: saveAs },
          { label: 'Mostrar no Finder', click: () => shell.showItemInFolder(currentFile()) },
          { type: 'separator' },
          { label: 'Importar imagem…', accelerator: 'CmdOrCtrl+Shift+K', click: importImage },
          {
            label: 'Exportar seleção',
            submenu: [
              ['PNG', 'png'], ['JPEG', 'jpeg'], ['WebP', 'webp'], ['PDF', 'pdf'], ['HTML + CSS', 'html-css'],
            ].map(([label, f]) => ({ label, click: () => exportSelection(f) })),
          },
          { type: 'separator' },
          isMac ? { role: 'close' } : { role: 'quit' },
        ],
      },
      // Undo/redo belong to the canvas (Cmd+Z handled by the editor); the roles cover text fields.
      { role: 'editMenu', label: 'Editar' },
      {
        label: 'Ver',
        submenu: [
          { label: 'Ajustar tudo', accelerator: 'Shift+1', click: () => win.webContents.executeJavaScript('window.pena.fit()') },
          { type: 'separator' },
          { role: 'reload', label: 'Recarregar' },
          { role: 'toggleDevTools', label: 'Ferramentas de desenvolvedor' },
          { type: 'separator' },
          { role: 'togglefullscreen', label: 'Tela cheia' },
        ],
      },
      { role: 'windowMenu', label: 'Janela' },
    ]),
  );
}

// macOS: double-clicking a .pen file (once associated) or dropping it on the dock icon.
let pendingFile = process.argv.slice(app.isPackaged ? 1 : 2).find((a) => a.endsWith('.pen'));
app.on('open-file', (e, file) => {
  e.preventDefault();
  if (app.isReady()) openFile(file);
  else pendingFile = file;
});

app.on('window-all-closed', () => app.quit());

// No top-level await here: Electron waits for the ESM entry to finish loading before emitting `ready`.
app.whenReady().then(async () => {
  baseUrl = await start({ file: pendingFile, port: 0 });
  // Agents render screenshots/exports in this window even when it's in the background.
  win = new BrowserWindow({ width: 1500, height: 950, title: 'Pena', backgroundColor: '#18181b', webPreferences: { backgroundThrottling: false } });
  win.on('page-title-updated', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url: target }) => (shell.openExternal(target), { action: 'deny' }));
  // The dashboard/editor navigate between each other through the server; keep the title in sync.
  win.webContents.on('did-navigate', (_e, url) => win.setTitle(url.endsWith('/dashboard') || !currentFile() ? 'Pena' : `${path.basename(currentFile())} — Pena`));
  buildMenu();
  await win.loadURL(pendingFile ? `${baseUrl}/` : `${baseUrl}/dashboard`);
  console.log(`Pena desktop → ${baseUrl}`);
});

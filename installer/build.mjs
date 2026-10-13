// Builds the one-click Windows installer:  node installer/build.mjs  (or: npm run installer)
//
// Output: installer/out/AmnaLab-LMS-Setup-<version>.exe  (a single file; nothing else to install on the lab PC)
// It contains: the built app, only the runtime node_modules, a private Node.js, the tray launcher and the uninstaller.
// Needs on the build PC: Node 22+ with npm (network, once, for runtime packages) and the C# compiler that ships
// with Windows (.NET Framework 4). No Visual Studio, no Inno Setup, no admin rights.
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const stage = join(here, 'stage');
const out = join(here, 'out');
const obj = join(here, 'obj');
const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
const version = pkg.version;
const skipBuild = process.argv.includes('--skip-build');

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', cwd: repo, ...opts });
const log = (m) => console.log(`\n== ${m}`);

if (process.platform !== 'win32') throw new Error('The installer is built on Windows.');
const csc = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
if (!existsSync(csc)) throw new Error(`C# compiler not found at ${csc}`);

// 1. Build the app.
if (!skipBuild) {
  log('Building the app');
  run(process.execPath, [join(repo, 'node_modules', 'vite', 'bin', 'vite.js'), 'build']);
  run(process.execPath, [join(repo, 'scripts', 'build-server.mjs')]);
}
for (const f of ['dist/server/index.js', 'dist/server/restore.js', 'dist/client/index.html']) {
  if (!existsSync(join(repo, f))) throw new Error(`Missing ${f}. Run without --skip-build.`);
}

// 2. Stage the files that go onto the lab PC.
log('Staging files');
for (const d of [stage, out, obj]) rmSync(d, { recursive: true, force: true });
for (const d of [stage, out, obj]) mkdirSync(d, { recursive: true });
cpSync(join(repo, 'dist'), join(stage, 'dist'), { recursive: true });
cpSync(join(repo, 'assets'), join(stage, 'assets'), { recursive: true });
copyFileSync(join(repo, 'README.md'), join(stage, 'README.md'));
writeFileSync(join(stage, 'VERSION'), version + '\n');

// Runtime packages: exactly the versions the app was tested with.
const installed = (name) => JSON.parse(readFileSync(join(repo, 'node_modules', name, 'package.json'), 'utf8')).version;
const runtimeDeps = Object.fromEntries(['@formepdf/core', '@formepdf/react', 'react'].map((n) => [n, installed(n)]));
writeFileSync(
  join(stage, 'package.json'),
  JSON.stringify({ name: 'amna-lab-lms-runtime', version, private: true, type: 'module', dependencies: runtimeDeps }, null, 2) + '\n',
);
log('Installing runtime packages');
const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
if (!existsSync(npmCli)) throw new Error(`npm not found next to Node at ${npmCli}`);
execFileSync(process.execPath, [npmCli, 'install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock'], { cwd: stage, stdio: 'inherit' });

// Private Node.js, so the lab PC needs nothing installed first.
log('Bundling the Node.js runtime ' + process.version);
mkdirSync(join(stage, 'runtime'), { recursive: true });
copyFileSync(process.execPath, join(stage, 'runtime', 'node.exe'));
const nodeLicense = join(dirname(process.execPath), 'LICENSE');
if (existsSync(nodeLicense)) copyFileSync(nodeLicense, join(stage, 'LICENSE-node.txt'));

// 3. Icon (drawn here, so the repo carries no binary assets).
log('Drawing the icon');
const icoScript = join(obj, 'make-icon.ps1');
const ico = join(obj, 'app.ico');
writeFileSync(
  icoScript,
  `Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 256,256
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'; $g.Clear([System.Drawing.Color]::Transparent)
$g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(31,95,174))), 8, 8, 240, 240)
$f = New-Object System.Drawing.Font 'Segoe UI', 130, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
$sf = New-Object System.Drawing.StringFormat; $sf.Alignment = 'Center'; $sf.LineAlignment = 'Center'
$g.DrawString('A', $f, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF 0, 8, 256, 256), $sf)
$ms = New-Object System.IO.MemoryStream; $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $png = $ms.ToArray()
$fs = [System.IO.File]::Create('${ico.replace(/\\/g, '\\\\')}'); $w = New-Object System.IO.BinaryWriter $fs
$w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]1)
$w.Write([byte]0); $w.Write([byte]0); $w.Write([byte]0); $w.Write([byte]0); $w.Write([UInt16]1); $w.Write([UInt16]32)
$w.Write([UInt32]$png.Length); $w.Write([UInt32]22); $w.Write($png); $w.Close(); $fs.Close()
`,
);
run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', icoScript]);

// 4. Compile.
const versionCs = join(obj, 'Version.cs');
const parts = version.split('.');
const v4 = `${parts[0] ?? 1}.${parts[1] ?? 0}.${parts[2] ?? 0}.0`;
writeFileSync(
  versionCs,
  `using System.Reflection;
[assembly: AssemblyVersion("${v4}")]
[assembly: AssemblyFileVersion("${v4}")]
[assembly: AssemblyCompany("Pro Health Digital LLC")]
[assembly: AssemblyProduct("Amna Lab LMS")]
`,
);
const compile = (target, outFile, sources, extra = []) =>
  run(csc, [
    '/nologo', '/optimize+', `/target:${target}`, `/out:${outFile}`, `/win32icon:${ico}`, `/win32manifest:${join(here, 'app.manifest')}`,
    '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.IO.Compression.dll', '/r:System.IO.Compression.FileSystem.dll',
    ...extra, ...sources, versionCs,
  ]);

log('Compiling the launcher and the uninstaller');
compile('winexe', join(stage, 'AmnaLabLMS.exe'), [join(here, 'Launcher.cs')], ['/main:AmnaLab.LauncherProgram']);
compile('winexe', join(stage, 'Uninstall.exe'), [join(here, 'Setup.cs')], ['/main:AmnaLab.SetupProgram']);

// 5. Zip the stage and embed it in the setup program.
log('Packing the payload');
const payload = join(obj, 'payload.zip');
const tar = join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'tar.exe');
if (!existsSync(tar)) throw new Error('tar.exe (Windows 10 or newer) is needed to build the payload.');
run(tar, ['-a', '-c', '-f', payload, '-C', stage, '.']);

const setupExe = join(out, `AmnaLab-LMS-Setup-${version}.exe`);
log('Compiling the setup program');
compile('winexe', setupExe, [join(here, 'Setup.cs')], ['/main:AmnaLab.SetupProgram', `/resource:${payload},payload.zip`]);

const bytes = readFileSync(setupExe);
const mb = (statSync(setupExe).size / 1048576).toFixed(1);
console.log(`\nInstaller: ${setupExe}\nSize: ${mb} MB\nSHA-256: ${createHash('sha256').update(bytes).digest('hex')}`);

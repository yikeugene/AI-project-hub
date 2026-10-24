const { getReleaseSource } = require('./scripts/release-source.cjs');
const source = getReleaseSource();

module.exports = {
  appId: 'local.aiprojecthub.desktop',
  productName: 'AI Project Hub',
  electronVersion: '44.9.0',
  directories: { app: '.desktop-build/app', output: 'release' },
  files: ['main.cjs', 'preload.cjs', 'package.json', 'release-source.json', 'icon.png', 'LICENSE-AI-PROJECT-HUB.txt', 'THIRD-PARTY-NOTICES.txt', 'dist/**/*', '!**/node_modules/**'],
  extraResources: [
    { from: '.desktop-build/app/git-tools', to: 'git-tools' },
    { from: '.desktop-build/app/app-observation', to: 'app-observation', filter: ['foreground-app.exe'] },
  ],
  extraFiles: [
    { from: '.desktop-build/app/THIRD-PARTY-NOTICES.txt', to: 'THIRD-PARTY-NOTICES.txt' },
    { from: '.desktop-build/app/LICENSE-AI-PROJECT-HUB.txt', to: 'LICENSE-AI-PROJECT-HUB.txt' },
  ],
  asar: true,
  // All runtime libraries are bundled. This supported hook skips both dependency
  // installation/rebuilding AND parent-directory node_modules collection.
  npmRebuild: true,
  beforeBuild: async () => false,
  forceCodeSigning: false,
  publish: source ? { provider: 'github', ...source, releaseType: 'release' } : null,
  win: {
    icon: '.desktop-build/app/icon.ico',
    target: [{ target: 'portable', arch: ['x64'] }, { target: 'nsis', arch: ['x64'] }],
    signExecutable: false,
  },
  portable: { artifactName: 'AI-Project-Hub-${version}-portable-${arch}.${ext}', requestExecutionLevel: 'user' },
  nsis: {
    include: 'desktop/installer.nsh',
    artifactName: 'AI-Project-Hub-${version}-Setup-${arch}.${ext}',
    oneClick: true, perMachine: false, createDesktopShortcut: true, createStartMenuShortcut: true,
    shortcutName: 'AI Project Hub', runAfterFinish: false, deleteAppDataOnUninstall: false,
  },
};

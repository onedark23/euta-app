// electron-updater behind the AppUpdater's small backend interface (ADR-042 · ADR-047). Generic provider; the
// feed (connected cloud server `/updates/<channel>/` or GitHub `releases/latest/download/`) is set before every
// check — the channel lives in the URL, so electron-updater's own channel stays "latest" (it reads latest.yml /
// latest-mac.yml / latest-linux.yml there).
import electronUpdater from 'electron-updater';
import { notesText, type UpdaterBackend } from './updater.js';

export function electronUpdaterBackend(opts: { dev?: boolean } = {}): UpdaterBackend {
  const { autoUpdater } = electronUpdater;
  let feed = '';
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true; // SPEC: quitting the app installs a downloaded update
  autoUpdater.allowPrerelease = true;
  autoUpdater.allowDowngrade = false;
  // E2E runs the unpackaged app: check against the feed for real, but never download or install.
  if (opts.dev) autoUpdater.forceDevUpdateConfig = true;
  // Quiet: failures surface as "마지막 확인: 실패" in 앱 설정, not as console noise.
  autoUpdater.logger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
  return {
    setFeed(url) {
      if (url === feed) return;
      feed = url;
      // The cloud server answers single Range requests only — Windows differential download asks per range.
      autoUpdater.setFeedURL({ provider: 'generic', url, useMultipleRangeRequest: false });
    },
    async check() {
      const r = await autoUpdater.checkForUpdates();
      if (!r?.isUpdateAvailable) return null;
      const notes = notesText(r.updateInfo.releaseNotes);
      return { version: r.updateInfo.version, ...(notes ? { notes } : {}) };
    },
    async download() {
      await autoUpdater.downloadUpdate();
    },
    install() {
      // Silent installer (NSIS), relaunch afterwards.
      autoUpdater.quitAndInstall(true, true);
    },
  };
}

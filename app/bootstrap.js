import { APP_RELEASE } from './release-version.js';

const badge = document.querySelector('#app-release');
if (badge) badge.textContent = `v${APP_RELEASE}`;

async function checkRelease() {
  const response = await fetch(`/release.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) {
    // Source-only local development does not have a build manifest.
    if (response.status === 404 && ['localhost', '127.0.0.1'].includes(location.hostname)) return true;
    throw new Error('暂时无法核对最新版本，请联网后刷新。');
  }
  const release = await response.json();
  if (typeof release.version !== 'string' || !/^6-\d+\.\d+\.\d+$/.test(release.version))
    throw new Error('版本信息异常，请稍后刷新。');
  if (release.version === APP_RELEASE) return true;
  const url = new URL(location.href);
  if (url.searchParams.get('release') === release.version)
    throw new Error('新版正在发布，请稍后刷新，当前编辑已暂停。');
  url.searchParams.set('release', release.version);
  location.replace(url.href);
  return false;
}

function showUpdateError(error) {
  document.querySelector('main').inert = true;
  document.querySelector('#workspace-lock').hidden = false;
  document.querySelector('#workspace-lock-text').textContent = error.message;
  const retry = document.querySelector('#workspace-lock-open');
  retry.textContent = '刷新到最新版本';
  retry.onclick = () => location.reload();
}

try {
  if (await checkRelease()) await import('./ui.js');
} catch (error) { showUpdateError(error); }

window.addEventListener('pageshow', event => {
  if (event.persisted) checkRelease().catch(showUpdateError);
});

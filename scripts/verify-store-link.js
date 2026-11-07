#!/usr/bin/env node
// Reviewing an EXE Store submission.
//
// A submission is a link, never an uploaded file, so the review is: fetch the link
// the way the app will, and report what actually comes back. This prints the status
// after redirects, the content type, the size, the SHA-256 of the bytes, and a
// paste-ready catalogue entry.
//
//   node scripts/verify-store-link.js https://example.com/app-setup.exe
//   node scripts/verify-store-link.js <installer-url> --page https://example.com/download
//
// The verdict is deliberately blunt: a link is only called a one-press install when
// it answered with an installer. A publisher page that returns HTML is a page-only
// entry, and a link that fails is not an entry at all.
//
// Nothing is written to disk: the response is hashed as it streams, so checking a
// 100 MB installer costs memory, not a stray file in the repository.

const crypto = require('crypto');

const MAX_BYTES = 512 * 1024 * 1024;
const TIMEOUT_MS = 120000;
// Vendors regularly answer a scripted request differently from a browser; a plain,
// honest user agent gets the same bytes a person would.
const USER_AGENT = 'RunContainer-store-review/1.0 (+https://runcontainer-7.github.io/9-runcontainer/)';

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown';
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB (${bytes.toLocaleString('en-US')} bytes)`;
}

function filenameFrom(url) {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    return name || '';
  } catch {
    return '';
  }
}

// The name to report is the one the server itself claims, because a CDN or a signed
// redirect usually hides the real file name in the address.
function filenameFromResponse(disposition, submittedUrl, finalUrl) {
  const header = String(disposition || '');
  const star = /filename\*=(?:UTF-8'')?"?([^;"]+)"?/i.exec(header);
  const plain = /filename="?([^";]+)"?/i.exec(header);
  const claimed = star ? star[1] : plain ? plain[1] : '';
  return claimed || filenameFrom(submittedUrl) || filenameFrom(finalUrl) || '(none in the address)';
}

// A signed or per-request address works once and then stops. It is fine to fetch and
// hash, and it must never be written into the catalogue: the entry keeps the address
// the submitter gave, which is the one the publisher maintains.
function looksEphemeral(url) {
  return /[?&](sig|se|sp|sv|skoid|skt|ske|token|expires|x-amz-)/i.test(String(url || ''));
}

// An installer is recognised from what the server says it is, not from a guess about
// the address: Mozilla's installer link carries no .exe and still returns one.
function looksLikeInstaller(contentType, finalUrl) {
  const type = String(contentType || '').toLowerCase();
  if (type.includes('text/html')) return false;
  if (type.includes('application/octet-stream') || type.includes('application/x-msdownload')) return true;
  if (type.includes('application/vnd.microsoft.portable-executable')) return true;
  return /\.exe($|\?)/i.test(finalUrl);
}

async function check(url, downloadPage) {
  const report = { url, downloadPage: downloadPage || null };
  let response;
  try {
    response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        // Hash the file itself: a compressed transfer would hash something else.
        'Accept-Encoding': 'identity',
        'User-Agent': USER_AGENT,
        Accept: '*/*',
      },
    });
  } catch (error) {
    return { ...report, ok: false, error: error?.message || String(error) };
  }

  const contentType = response.headers.get('content-type') || '';
  const disposition = response.headers.get('content-disposition') || '';
  const declaredLength = Number(response.headers.get('content-length'));
  const hash = crypto.createHash('sha256');
  let bytes = 0;

  if (response.body) {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) {
        return { ...report, ok: false, error: `response exceeded ${formatBytes(MAX_BYTES)}; not hashed` };
      }
      hash.update(chunk);
    }
  }

  const installer = response.ok && looksLikeInstaller(contentType, response.url);
  return {
    ...report,
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    finalUrl: response.url,
    redirected: response.url !== url,
    contentType: contentType || '(none)',
    declaredLength: Number.isFinite(declaredLength) ? declaredLength : null,
    bytes,
    sha256: hash.digest('hex'),
    filename: filenameFromResponse(disposition, url, response.url),
    contentDisposition: disposition || '(none)',
    ephemeralFinalUrl: looksEphemeral(response.url),
    installer,
  };
}

function entrySnippet(result, extras = {}) {
  const name = extras.name || '<App name>';
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const sizeMb = result.bytes ? Math.max(1, Math.round(result.bytes / (1024 * 1024))) : extras.sizeMb || 0;
  const lines = [
    '  {',
    `    id: '${id}',`,
    `    name: '${name}',`,
    `    publisher: '${extras.publisher || '<Publisher>'}',`,
    `    summary: '${extras.summary || '<One sentence on what it is for.>'}',`,
    `    category: '${extras.category || 'Utilities'}',`,
    `    license: '${extras.license || '<Licence>'}',`,
    `    approxSizeMb: ${sizeMb},`,
    `    glyph: '${(name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || 'AP')}',`,
    `    installNote: '${result.installer
      ? 'Downloads the current Windows installer from the publisher.'
      : 'Opens the official download page; the installer is chosen there.'}',`,
    // The submitted address, not the redirect target: a signed CDN link expires and
    // would 404 for every user after it does.
    result.installer ? '    directInstall: true,' : '    // No verified installer link: the store opens the publisher page instead.',
    `    installerUrl: ${result.installer ? `'${result.url}'` : 'null'},`,
    `    downloadPage: '${extras.downloadPage || result.downloadPage || '<Publisher download page>'}',`,
    `    // Verified ${new Date().toISOString().slice(0, 10)} · SHA-256 ${result.sha256}`,
    '  },',
  ];
  return lines.join('\n');
}

function printResult(result, extras) {
  console.log('');
  console.log(`Submitted  ${result.url}`);
  if (result.error) {
    console.log(`Result     FAILED — ${result.error}`);
    console.log('Verdict    not an entry: the link has to answer before it can be reviewed.');
    return;
  }
  console.log(`Result     ${result.status} ${result.statusText}${result.redirected ? ` after redirect to ${result.finalUrl}` : ''}`);
  console.log(`Type       ${result.contentType}`);
  console.log(`Size       ${formatBytes(result.bytes)}${result.declaredLength && result.declaredLength !== result.bytes ? ` (server declared ${result.declaredLength})` : ''}`);
  console.log(`File       ${result.filename}`);
  if (result.ephemeralFinalUrl) {
    console.log('Note       the redirect target is a signed, expiring address. Keep the submitted');
    console.log('           address in the catalogue — never the redirect it lands on.');
  }
  console.log(`SHA-256    ${result.sha256}`);
  if (!result.ok) {
    console.log('Verdict    reject or ask for a current link: the publisher did not serve it.');
    return;
  }
  if (!result.installer) {
    console.log('Verdict    PAGE ONLY — this answered with something other than an installer.');
    console.log('           Add it with installerUrl: null and let the store open the download page.');
  } else {
    console.log('Verdict    ONE-PRESS OK — answered with an installer over https.');
    console.log('           Paste that SHA-256 into the release notes or the submission, so a user can compare.');
  }
  console.log('');
  console.log('Catalogue entry (check every field before committing):');
  console.log(entrySnippet(result, extras));
}

function parseArgs(argv) {
  const urls = [];
  const extras = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--page') extras.downloadPage = argv[++i];
    else if (arg === '--name') extras.name = argv[++i];
    else if (arg === '--publisher') extras.publisher = argv[++i];
    else if (arg === '--category') extras.category = argv[++i];
    else if (arg === '--license') extras.license = argv[++i];
    else if (arg === '--summary') extras.summary = argv[++i];
    else urls.push(arg);
  }
  return { urls, extras };
}

async function main() {
  const { urls, extras } = parseArgs(process.argv.slice(2));
  if (urls.length === 0) {
    console.error('Usage: node scripts/verify-store-link.js <installer-url> [more urls] \\');
    console.error('         [--page <download page>] [--name <app>] [--publisher <who>] [--category <cat>] [--license <licence>]');
    process.exitCode = 2;
    return;
  }
  if (!extras.downloadPage) {
    console.error('Reminder: every entry needs a downloadPage, in case the installer link stops working.');
  }
  let anyInstaller = false;
  for (const url of urls) {
    if (!/^https:\/\//i.test(url)) {
      console.log(`\nSubmitted  ${url}`);
      console.log('Verdict    reject: the store only links over https.');
      continue;
    }
    const result = await check(url, extras.downloadPage);
    printResult(result, extras);
    if (result.installer) anyInstaller = true;
  }
  console.log('');
  console.log(anyInstaller
    ? 'Next: add the entry to src/data/exeStore.js, then run `CI=true npx react-scripts test --watchAll=false`.'
    : 'Next: add a page-only entry to src/data/exeStore.js, or ask the submitter for a direct installer link.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`The check could not run: ${error?.message || error}`);
    process.exitCode = 1;
  });
}

module.exports = { check, looksLikeInstaller, entrySnippet };

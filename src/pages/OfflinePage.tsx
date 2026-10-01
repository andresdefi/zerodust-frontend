import { StaticPage } from './Layout';
import { OFFLINE_FILE, type PageBuild as BuildRecord } from './build-record';

export function OfflinePage({ build }: { build: BuildRecord }) {
  return (
    <StaticPage>
      <h1>Offline page</h1>
      <p className="doc-lede">
        The same sweeper as this site, as one HTML file. Download it once, check its hash, and open it from
        your own disk whenever you need it. No hosted page is involved, so a change to this website cannot
        change the file you run.
      </p>

      <p>
        <a className="btn btn-primary" href={`/download/${OFFLINE_FILE.replace(/\.html$/, "")}`} download={OFFLINE_FILE}>Download the offline page</a>
      </p>
      <dl className="hashes">
        <dt>SHA-256</dt>
        <dd><code>{build.offlineSha256}</code></dd>
      </dl>

      <h2>Check it before you open it</h2>
      <p>The hash of the file you downloaded must match the one above, character for character.</p>
      <pre className="cmd"><code>{`# macOS and Linux
shasum -a 256 ${OFFLINE_FILE}

# Windows (PowerShell)
Get-FileHash ${OFFLINE_FILE} -Algorithm SHA256`}</code></pre>
      <p>
        The file is also rebuilt and hashed by anyone who builds the public source: see{' '}
        <a href="/security">Security</a>.
      </p>

      <h2>Using it</h2>
      <ul>
        <li>Open the file in your browser (double-click it, or drag it onto a browser window).</li>
        <li>It still needs the internet to read balances, get quotes and send transactions, exactly like the site.</li>
        <li>
          Its own Content-Security-Policy allows only the code inside the file and the same API and chain
          endpoints as the site. Your key stays in the tab, as on the site.
        </li>
        <li>Keep the file. When a new version is published here, download it and check the new hash.</li>
      </ul>
    </StaticPage>
  );
}

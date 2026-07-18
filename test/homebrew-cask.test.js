import test from 'node:test';
import assert from 'node:assert/strict';
import { renderHomebrewCask } from '../scripts/render-homebrew-cask.mjs';

const ARM64_SHA256 = 'a'.repeat(64);
const X64_SHA256 = 'b'.repeat(64);

test('renders an architecture-specific Homebrew Cask', () => {
  const cask = renderHomebrewCask({
    version: '1.2.3',
    arm64Sha256: ARM64_SHA256,
    x64Sha256: X64_SHA256,
  });

  assert.match(cask, /arch arm: "arm64", intel: "x64"/);
  assert.match(cask, /version "1\.2\.3"/);
  assert.match(cask, new RegExp(`sha256 arm:   "${ARM64_SHA256}"`));
  assert.match(cask, new RegExp(`intel: "${X64_SHA256}"`));
  assert.match(cask, /agentarium-space-#\{version\}-macos-#\{arch\}\.zip/);
  assert.match(cask, /app "Agentarium Space\.app"/);
  assert.match(cask, /depends_on macos: :monterey/);
  assert.match(cask, /Developer ID signing may be blocked on first launch/);
  assert.match(cask, /System Settings > Privacy & Security/);
  assert.doesNotMatch(cask, /quarantine\s+false/);
  assert.ok(cask.indexOf('zap trash:') < cask.indexOf('caveats <<~EOS'));
});

test('rejects values that could corrupt the Cask source', () => {
  assert.throws(() => renderHomebrewCask({
    version: '1.2.3\nend',
    arm64Sha256: ARM64_SHA256,
    x64Sha256: X64_SHA256,
  }), /Invalid version/);

  assert.throws(() => renderHomebrewCask({
    version: '1.2.3',
    arm64Sha256: 'not-a-checksum',
    x64Sha256: X64_SHA256,
  }), /Invalid arm64 SHA-256/);
});

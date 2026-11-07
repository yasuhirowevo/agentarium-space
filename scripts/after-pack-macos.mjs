import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const plistPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents',
    'Info.plist',
  );
  await execFileAsync('plutil', [
    '-replace',
    'NSAppTransportSecurity.NSAllowsArbitraryLoads',
    '-bool',
    'NO',
    plistPath,
  ]);
  const { stdout } = await execFileAsync('plutil', [
    '-extract',
    'NSAppTransportSecurity.NSAllowsArbitraryLoads',
    'raw',
    '-o',
    '-',
    plistPath,
  ]);
  assert.equal(stdout.trim(), 'false', 'macOS package must disable arbitrary network loads');
}

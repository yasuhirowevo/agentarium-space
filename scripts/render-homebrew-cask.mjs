import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function requireMatch(label, value, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`Invalid ${label}: ${value ?? '<missing>'}`);
  }
  return value;
}

export function renderHomebrewCask({ version, arm64Sha256, x64Sha256 }) {
  const safeVersion = requireMatch('version', version, VERSION_PATTERN);
  const safeArm64Sha256 = requireMatch('arm64 SHA-256', arm64Sha256, SHA256_PATTERN);
  const safeX64Sha256 = requireMatch('x64 SHA-256', x64Sha256, SHA256_PATTERN);

  return `cask "agentarium-space" do
  arch arm: "arm64", intel: "x64"

  version "${safeVersion}"
  sha256 arm:   "${safeArm64Sha256}",
         intel: "${safeX64Sha256}"

  url "https://github.com/yasuhirowevo/agentarium-space/releases/download/v#{version}/agentarium-space-#{version}-macos-#{arch}.zip"
  name "Agentarium Space"
  desc "Local-only visualizer for Claude Code and Codex CLI sessions"
  homepage "https://github.com/yasuhirowevo/agentarium-space"

  depends_on macos: ">= :monterey"

  app "Agentarium Space.app"

  zap trash: [
    "~/Library/Application Support/Agentarium Space",
    "~/Library/Preferences/io.github.yasuhirowevo.agentarium-space.plist",
    "~/Library/Saved Application State/io.github.yasuhirowevo.agentarium-space.savedState",
  ]

  caveats <<~EOS
    Releases without optional Developer ID signing may be blocked on first launch.
    After verifying this download came from the official Agentarium Space release,
    open System Settings > Privacy & Security and choose "Open Anyway".
    This Cask does not remove macOS quarantine automatically.
  EOS
end
`;
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined) {
      throw new Error(`Expected --name value pairs, received: ${argv.join(' ')}`);
    }
    options[flag.slice(2)] = value;
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (!options.output) throw new Error('Missing --output');

  const cask = renderHomebrewCask({
    version: options.version,
    arm64Sha256: options['arm64-sha256'],
    x64Sha256: options['x64-sha256'],
  });
  const outputPath = path.resolve(options.output);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, cask, 'utf8');
  console.log(`Wrote ${outputPath}`);
}

const isDirectRun = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

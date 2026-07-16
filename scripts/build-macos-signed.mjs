import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const REQUIRED_SIGNING_ENV = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
];

export function validateSigningEnvironment(env = process.env) {
  const missing = REQUIRED_SIGNING_ENV.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Signed and notarized macOS builds require all environment variables. Missing: ${missing.join(', ')}`,
    );
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  validateSigningEnvironment(env);

  const electronBuilder = path.resolve('node_modules', '.bin', 'electron-builder');
  const args = [
    '--mac',
    'zip',
    '--publish',
    'never',
    '-c.mac.forceCodeSigning=true',
    '-c.mac.notarize=true',
    ...argv,
  ];

  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(electronBuilder, args, { env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`electron-builder terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });

  if (exitCode !== 0) process.exitCode = exitCode;
}

const isDirectRun = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

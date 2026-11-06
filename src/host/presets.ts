// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
export const COMMON_PERMISSIONS: readonly string[] = Object.freeze([
  'Read', 'Grep', 'Glob', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)',
  'Bash(git branch)', 'Bash(git branch --list)', 'Bash(pwd)', 'Bash(ls:*)',
  'Bash(orch mailbox read:*)', 'Bash(orch host status:*)', 'Bash(orch lead status:*)',
]);
export const CODING_PERMISSIONS: readonly string[] = Object.freeze([
  ...COMMON_PERMISSIONS, 'Bash(npm test:*)', 'Bash(npm run test:*)', 'Bash(npm run lint:*)', 'Bash(npm run typecheck:*)', 'Bash(npm run build:*)',
  'Bash(pnpm test:*)', 'Bash(pnpm run test:*)', 'Bash(pnpm lint:*)', 'Bash(pnpm run lint:*)', 'Bash(pnpm typecheck:*)', 'Bash(pnpm run typecheck:*)', 'Bash(pnpm build:*)', 'Bash(pnpm run build:*)',
  'Bash(yarn test:*)', 'Bash(yarn run test:*)', 'Bash(yarn lint:*)', 'Bash(yarn run lint:*)', 'Bash(yarn typecheck:*)', 'Bash(yarn run typecheck:*)', 'Bash(yarn build:*)', 'Bash(yarn run build:*)', 'Bash(node --version)',
]);
export const RESEARCH_PERMISSIONS: readonly string[] = Object.freeze([...COMMON_PERMISSIONS, 'WebSearch', 'WebFetch']);
export const OPS_PERMISSIONS: readonly string[] = Object.freeze([...COMMON_PERMISSIONS, 'Bash(orch task status:*)', 'Bash(orch task list:*)', 'Bash(orch mem search:*)']);
export const HOST_PRESETS: Readonly<Record<string, readonly string[]>> = Object.freeze({ coding: CODING_PERMISSIONS, research: RESEARCH_PERMISSIONS, ops: OPS_PERMISSIONS });

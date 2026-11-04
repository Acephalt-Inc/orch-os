import { describe, expect, it } from 'vitest';
import { COMMON_PERMISSIONS, CODING_PERMISSIONS, RESEARCH_PERMISSIONS, OPS_PERMISSIONS, HOST_PRESETS } from '../src/host/presets.js';

const common = ['Read', 'Grep', 'Glob', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git branch)', 'Bash(git branch --list)', 'Bash(pwd)', 'Bash(ls:*)', 'Bash(orch mailbox read:*)', 'Bash(orch host status:*)', 'Bash(orch lead status:*)'];
const expected = {
  coding: [...common, 'Bash(npm test:*)', ...['test', 'lint', 'typecheck', 'build'].map(x => `Bash(npm run ${x}:*)`), ...['pnpm', 'yarn'].flatMap(p => ['test', 'lint', 'typecheck', 'build'].flatMap(x => [`Bash(${p} ${x}:*)`, `Bash(${p} run ${x}:*)`])), 'Bash(node --version)'],
  research: [...common, 'WebSearch', 'WebFetch'],
  ops: [...common, 'Bash(orch task status:*)', 'Bash(orch task list:*)', 'Bash(orch mem search:*)'],
};
// Models only exact and :* single-command rules, not Claude's shell parser.
function permits(rules: readonly string[], command: string): boolean {
  return rules.some(rule => {
    const match = /^Bash\(([^()]*)\)$/.exec(rule); if (!match) return false;
    const body = match[1]; if (!body.endsWith(':*')) return command === body;
    const prefix = body.slice(0, -2); return command === prefix || command.startsWith(prefix + ' ');
  });
}

describe('host permission presets', () => {
  it('exports exactly the canonical immutable permission sets', () => {
    expect(Object.keys(HOST_PRESETS)).toEqual(['coding', 'research', 'ops']);
    expect(COMMON_PERMISSIONS).toEqual(common); expect(CODING_PERMISSIONS).toEqual(expected.coding);
    expect(RESEARCH_PERMISSIONS).toEqual(expected.research); expect(OPS_PERMISSIONS).toEqual(expected.ops);
    expect(HOST_PRESETS).toEqual(expected); expect(Object.isFrozen(HOST_PRESETS)).toBe(true);
    for (const rules of [COMMON_PERMISSIONS, ...Object.values(HOST_PRESETS)]) {
      expect(Object.isFrozen(rules)).toBe(true); expect(new Set(rules).size).toBe(rules.length);
      for (const rule of rules) expect(rule).toMatch(/^(?:Read|Grep|Glob|WebSearch|WebFetch|Bash\([a-z0-9 -]+(?::\*)?\))$/);
      expect(rules).not.toContain('Bash'); expect(rules).not.toContain('Bash(*)');
    }
  });
  it('matches arguments on command boundaries and preserves exact commands', () => {
    for (const rules of Object.values(HOST_PRESETS)) {
      for (const command of ['git status', 'git status --short', 'git diff HEAD', 'ls -la', 'orch mailbox read inbox', 'git branch', 'git branch --list', 'pwd']) expect(permits(rules, command), command).toBe(true);
      for (const command of ['git statusx', 'git branch new', 'pwd extra', 'orch mailbox reader']) expect(permits(rules, command), command).toBe(false);
    }
    for (const command of ['npm test -- --watch', 'npm run test -- --watch', 'pnpm run build --filter x', 'yarn lint --fix', 'node --version']) expect(permits(CODING_PERMISSIONS, command), command).toBe(true);
    for (const command of ['npm test:deploy', 'npm testing', 'npm run test:deploy', 'pnpm testing', 'yarn test:deploy', 'node --version extra']) expect(permits(CODING_PERMISSIONS, command), command).toBe(false);
  });
  it('excludes dangerous or outward-facing commands from every preset', () => {
    const denied = ['git push', 'git commit -m x', 'git reset --hard', 'git checkout main', 'git clean -fd', 'rm file', 'mv a b', 'npm publish', 'npm install', 'curl example.com', 'ssh host', 'sudo ls', 'deploy', 'send', 'email', 'orch msg send hello', 'orch mailbox post hello', 'orch worker start', 'orch host install', 'orch host uninstall', 'orch task claim', 'orch task renew', 'orch task release', 'orch mem add', 'orch mem retire', 'node script.js', 'node -e code'];
    for (const [name, rules] of Object.entries(HOST_PRESETS)) for (const command of denied) expect(permits(rules, command), `${name}: ${command}`).toBe(false);
  });
});

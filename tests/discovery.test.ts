import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalDirectory, scanProjects } from '../server/discovery.ts';

let temporary: string;
beforeEach(async () => { temporary = await mkdtemp(path.join(tmpdir(), 'ai-project-hub-discovery-')); });
afterEach(async () => {
  vi.restoreAllMocks();
  if (temporary) await rm(temporary, { recursive: true, force: true });
});
async function directory(relative: string): Promise<string> {
  const target = path.join(temporary, relative);
  await mkdir(target, { recursive: true });
  return target;
}
async function project(relative: string, marker = 'package.json'): Promise<string> {
  const target = await directory(relative);
  await writeFile(path.join(target, marker), '{}');
  return target;
}

describe('canonicalDirectory', () => {
  it('normalizes existing absolute directories, dots, trailing separators and disk spelling', async () => {
    const target = await directory('space & unicode 專案');
    await directory('space & unicode 專案/child');
    const canonical = await realpath(target);
    expect(await canonicalDirectory(`${target}${path.sep}child${path.sep}..${path.sep}`)).toBe(canonical);
    if (process.platform === 'win32') expect(await canonicalDirectory(target.toUpperCase())).toBe(canonical);
  });
  it.each(['', '.', 'relative/project', 'C:relative', '\\\\server\\share', '//server/share', '\\\\?\\C:\\repo', '\\\\.\\C:\\repo', 'bad\0path'])(
    'rejects relative, UNC, device and malformed paths: %s', async (input) => {
      await expect(canonicalDirectory(input)).rejects.toThrow(/absolute local directory/);
    },
  );
  it('reports missing paths and files rather than accepting them as directories', async () => {
    await writeFile(path.join(temporary, 'file'), 'hello');
    await expect(canonicalDirectory(path.join(temporary, 'missing'))).rejects.toThrow(/does not exist/);
    await expect(canonicalDirectory(path.join(temporary, 'file'))).rejects.toThrow(/not a directory/);
  });
  it('resolves an explicitly supplied junction or symlink alias to its real directory', async () => {
    const target = await directory('target');
    const alias = path.join(temporary, 'alias');
    await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(await canonicalDirectory(alias)).toBe(await realpath(target));
  });
});

describe('scanProjects', () => {
  it('finds Git directories, gitfiles/worktrees, and non-Git markers without nested false positives', async () => {
    const git = await directory('git-project/.git');
    await project('git-project/nested/false-positive');
    const worktree = await project('worktree', '.git');
    await writeFile(path.join(worktree, '.git'), 'gitdir: ../metadata/worktrees/demo\n');
    const plain = await project('non-git');
    await writeFile(path.join(plain, 'pyproject.toml'), '[project]');
    await project('non-git/nested');
    await directory('not-a-project');
    const result = await scanProjects(temporary);
    expect(result.candidates).toEqual([
      { path: await realpath(path.dirname(git)), name: 'git-project', kind: 'git', markers: ['.git'] },
      { path: await realpath(plain), name: 'non-git', kind: 'project', markers: ['package.json', 'pyproject.toml'] },
      { path: await realpath(worktree), name: 'worktree', kind: 'git', markers: ['.git'] },
    ]);
    expect(result.truncated).toBe(false);
    expect(result.warnings).toEqual([]);
  });
  it('recognizes a root project and stops before its child packages', async () => {
    await writeFile(path.join(temporary, 'Cargo.toml'), '[package]');
    await project('packages/child');
    const result = await scanProjects(temporary);
    expect(result.visited).toBe(1);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].markers).toEqual(['Cargo.toml']);
  });
  it('recognizes .NET markers but does not consider a README alone a project', async () => {
    const dotnet = await project('dotnet', 'Example.csproj');
    await project('docs-only', 'README.md');
    expect((await scanProjects(temporary)).candidates.map((candidate) => candidate.path)).toEqual([await realpath(dotnet)]);
  });
  it('skips generated folders and directory links, including junction loops and external trees', async () => {
    for (const ignored of ['node_modules', 'vendor', 'dist', 'build', 'target', '.venv', '__pycache__', '.next', '.cache', '.ai-project-hub', 'obj']) {
      await project(`workspace/${ignored}/fake-project`);
    }
    const outside = await project('outside');
    const root = await directory('workspace');
    await symlink(outside, path.join(root, 'linked-project'), process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(root, path.join(root, 'loop'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = await scanProjects(root);
    expect(result.candidates).toEqual([]);
    expect(result.visited).toBe(1);
    expect(result.truncated).toBe(false);
  });
  it('does not follow a .git junction as a Git marker', async () => {
    const metadata = await directory('metadata');
    const root = await directory('workspace');
    await symlink(metadata, path.join(root, '.git'), process.platform === 'win32' ? 'junction' : 'dir');
    expect((await scanProjects(root)).candidates).toEqual([]);
  });
  it('counts root as depth zero and defaults to a maximum depth of four', async () => {
    await project('a/b/c/four');
    await project('other/b/c/d/five');
    expect((await scanProjects(temporary, { depth: 0 })).candidates).toEqual([]);
    expect((await scanProjects(temporary, { depth: 3 })).candidates).toEqual([]);
    expect((await scanProjects(temporary)).candidates.map((candidate) => candidate.name)).toEqual(['four']);
    expect((await scanProjects(temporary, { depth: 5 })).candidates.map((candidate) => candidate.name).sort()).toEqual(['five', 'four']);
  });
  it('bounds directory visits and explicitly reports truncation', async () => {
    await project('a'); await project('b'); await project('c');
    const result = await scanProjects(temporary, { maxDirectories: 2 });
    expect(result.visited).toBe(2);
    expect(result.candidates).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/limit of 2 directories/);
  });
  it('returns a bounded partial result when the wall-clock deadline expires', async () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(100);
    const result = await scanProjects(temporary, { timeoutMs: 10 });
    expect(result.truncated).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/stopped after 10 ms/);
    expect(result.visited).toBe(0);
  });
  it.each([
    { depth: -1 }, { depth: 1.5 }, { depth: 13 }, { maxDirectories: 0 },
    { maxDirectories: 10_001 }, { timeoutMs: 0 }, { timeoutMs: 15_001 },
  ])('rejects unbounded or invalid options: %j', async (options) => {
    await expect(scanProjects(temporary, options)).rejects.toThrow(/must be an integer/);
  });
  it('rejects a missing scan root instead of claiming an empty successful scan', async () => {
    await expect(scanProjects(path.join(temporary, 'missing'))).rejects.toThrow(/does not exist/);
  });
});

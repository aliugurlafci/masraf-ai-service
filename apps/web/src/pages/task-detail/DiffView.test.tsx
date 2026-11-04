import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { IDS, makeDiffFile, makeMergeCheck, page } from '../../test/fixtures';
import { installFetch, json, problem } from '../../test/http';
import type { FetchMock } from '../../test/http';
import { renderRoute } from '../../test/render';
import { DIFF_PAGE_SIZE, DiffView } from './DiffView';

const TASK_PATH = `/api/v1/tasks/${IDS.task}`;

function renderDiff(attemptId?: string) {
  return renderRoute(<DiffView taskId={IDS.task} attemptId={attemptId} />, {
    path: `/tasks/${IDS.task}`,
    routePath: '/tasks/:taskId',
  });
}

describe('DiffView (contract §20.2 diff tab)', () => {
  let http: FetchMock;

  beforeEach(() => {
    http = installFetch();
    http.on('GET', `${TASK_PATH}/merge-check`, json(makeMergeCheck()));
  });

  it('renders the files from /diff as unified diffs with line numbers and add/delete colouring', async () => {
    http.on('GET', `${TASK_PATH}/diff`, json(page([makeDiffFile(1)])));
    renderDiff(IDS.attempt1);

    const file = await screen.findByRole('region', { name: 'src/file-1.ts' });
    const [req] = http.calls('GET', `${TASK_PATH}/diff`);
    expect(req?.search.get('limit')).toBe(String(DIFF_PAGE_SIZE));
    expect(req?.search.get('attemptId')).toBe(IDS.attempt1);
    expect(http.calls('GET', `${TASK_PATH}/merge-check`)[0]?.search.get('attemptId')).toBe(IDS.attempt1);

    expect(within(file).getByText('modified')).toBeInTheDocument();
    expect(within(file).getByText('+2')).toBeInTheDocument();
    expect(within(file).getByText('-1')).toBeInTheDocument();

    const deleted = within(file).getByText('const b = 2;').closest('tr');
    expect(deleted).toHaveClass('diff-delete');
    expect(within(deleted as HTMLElement).getByLabelText('old line 11')).toBeInTheDocument();
    const added = within(file).getByText('const c = 4;').closest('tr');
    expect(added).toHaveClass('diff-add');
    expect(within(added as HTMLElement).getByLabelText('new line 12')).toBeInTheDocument();
    const context = within(file).getByText('return a + b;').closest('tr');
    expect(context).toHaveClass('diff-context');
    expect(within(context as HTMLElement).getByLabelText('old line 12')).toBeInTheDocument();
    expect(within(context as HTMLElement).getByLabelText('new line 13')).toBeInTheDocument();
    expect(within(file).getByText('@@ -10,3 +10,4 @@ export function total()').closest('tr')).toHaveClass('diff-hunk');

    expect(screen.getByRole('link', { name: 'Download patch' })).toHaveAttribute(
      'href',
      `${TASK_PATH}/patch?attemptId=${IDS.attempt1}`,
    );
  });

  it('shows banners instead of the patch for truncated, purged and binary files', async () => {
    http.on(
      'GET',
      `${TASK_PATH}/diff`,
      json(
        page([
          makeDiffFile(1, { patch: null, patchTruncated: true, patchBytes: 3_000_000 }),
          makeDiffFile(2, { patch: null, patchPurged: true }),
          makeDiffFile(3, { path: 'assets/logo.png', patch: null, isBinary: true, additions: null, deletions: null }),
        ]),
      ),
    );
    renderDiff();

    const truncated = await screen.findByRole('region', { name: 'src/file-1.ts' });
    expect(within(truncated).getByText('Patch truncated')).toBeInTheDocument();
    expect(within(truncated).getByRole('link', { name: 'Download the full patch' })).toHaveAttribute('href', `${TASK_PATH}/patch`);
    expect(within(truncated).queryByRole('table')).not.toBeInTheDocument();

    const purged = screen.getByRole('region', { name: 'src/file-2.ts' });
    expect(within(purged).getByText('Patch removed by retention')).toBeInTheDocument();
    expect(within(purged).queryByRole('table')).not.toBeInTheDocument();

    const binary = screen.getByRole('region', { name: 'assets/logo.png' });
    expect(within(binary).getByText('Binary file')).toBeInTheDocument();
    expect(within(binary).queryByRole('table')).not.toBeInTheDocument();
  });

  it('lists merge-check conflicts', async () => {
    http.on('GET', `${TASK_PATH}/diff`, json(page([makeDiffFile(1)])));
    http.on(
      'GET',
      `${TASK_PATH}/merge-check`,
      json(makeMergeCheck({ status: 'conflicts', conflicts: ['src/file-1.ts', 'package.json'] })),
    );
    renderDiff();

    const check = await screen.findByTestId('merge-check');
    expect(within(check).getByText('main')).toBeInTheDocument();
    expect(check.querySelector('[data-status]')).toHaveAttribute('data-status', 'conflicts');
    expect(within(check).getByText('Conflicting files')).toBeInTheDocument();
    expect(within(check).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['src/file-1.ts', 'package.json']);
  });

  it('shows a clean merge check without a conflict list and tolerates a missing merge check', async () => {
    http.on('GET', `${TASK_PATH}/diff`, json(page([makeDiffFile(1)])));
    const first = renderDiff();
    const check = await screen.findByTestId('merge-check');
    expect(check.querySelector('[data-status]')).toHaveAttribute('data-status', 'clean');
    expect(within(check).queryByText('Conflicting files')).not.toBeInTheDocument();
    first.unmount();

    http.on('GET', `${TASK_PATH}/merge-check`, problem(404, 'merge_check_unavailable', 'Merge check not available'));
    renderDiff();
    expect(await screen.findByText('Merge check not available for this attempt.')).toBeInTheDocument();
  });

  it('pages 20 files at a time with "Load more"', async () => {
    const firstPage = Array.from({ length: DIFF_PAGE_SIZE }, (_, i) => makeDiffFile(i + 1));
    http.on('GET', `${TASK_PATH}/diff`, (req) =>
      req.search.get('cursor') === 'page-2' ? json(page([makeDiffFile(21)])) : json(page(firstPage, 'page-2')),
    );
    const { user } = renderDiff();

    await screen.findByRole('region', { name: 'src/file-20.ts' });
    expect(screen.queryByRole('region', { name: 'src/file-21.ts' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByRole('region', { name: 'src/file-21.ts' })).toBeInTheDocument();
    expect(http.calls('GET', `${TASK_PATH}/diff`).map((r) => r.search.get('cursor'))).toEqual([null, 'page-2']);
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('shows the empty state and the Problem details on errors', async () => {
    http.on('GET', `${TASK_PATH}/diff`, json(page([])));
    const first = renderDiff();
    expect(await screen.findByText('No file changes were captured for this attempt.')).toBeInTheDocument();
    first.unmount();

    http.on('GET', `${TASK_PATH}/diff`, problem(500, 'internal_error', 'Internal error', { detail: 'diff store unavailable' }));
    renderDiff();
    expect(await screen.findByText('diff store unavailable')).toBeInTheDocument();
    expect(screen.getByText(/req-12345678/)).toBeInTheDocument();
  });
});

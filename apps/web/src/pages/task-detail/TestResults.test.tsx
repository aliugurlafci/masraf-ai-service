import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { IDS, makeProject, makeTestResult, makeTestRun, page } from '../../test/fixtures';
import { installFetch, json, problem } from '../../test/http';
import type { FetchMock } from '../../test/http';
import { renderRoute } from '../../test/render';
import { TestResults } from './TestResults';

const TASK_PATH = `/api/v1/tasks/${IDS.task}`;
const RESULTS_PATH = `${TASK_PATH}/tests/${IDS.testRun}/results`;

function renderTests() {
  return renderRoute(<TestResults taskId={IDS.task} attemptId={undefined} projectId={IDS.project} />, {
    path: `/tasks/${IDS.task}?tab=tests`,
    routePath: '/tasks/:taskId',
  });
}

function stat(counts: HTMLElement, label: string): string | null {
  return within(counts).getByText(label).nextElementSibling?.textContent ?? null;
}

describe('TestResults (contract §20.2 tests tab)', () => {
  let http: FetchMock;

  beforeEach(() => {
    http = installFetch();
    http.on('GET', `/api/v1/projects/${IDS.project}`, json(makeProject()));
  });

  it('shows the run summary counts, command and duration', async () => {
    http.on('GET', `${TASK_PATH}/tests`, json([makeTestRun()]));
    http.on('GET', RESULTS_PATH, json(page([])));
    renderTests();

    const run = await screen.findByRole('region', { name: 'Test run npm test' });
    expect(within(run).getByText('npm test')).toBeInTheDocument();
    expect(run.querySelector('.test-run-header [data-status]')).toHaveAttribute('data-status', 'failed');
    expect(within(run).getByText(/exit 1/)).toBeInTheDocument();
    const counts = within(run).getByLabelText('Test counts');
    expect(stat(counts, 'Total')).toBe('12');
    expect(stat(counts, 'Passed')).toBe('10');
    expect(stat(counts, 'Failed')).toBe('1');
    expect(stat(counts, 'Errors')).toBe('0');
    expect(stat(counts, 'Skipped')).toBe('1');
  });

  it('pre-filters failing runs and expands the failing case detail', async () => {
    http.on('GET', `${TASK_PATH}/tests`, json([makeTestRun()]));
    http.on('GET', RESULTS_PATH, (req) =>
      req.search.get('status') === 'failed'
        ? json(
            page([
              makeTestResult(1, {
                status: 'failed',
                name: 'rounds half up',
                failureType: 'AssertionError',
                failureMessage: 'expected 10.01 to equal 10.00',
                failureDetail: 'at invoice.test.ts:42:7',
              }),
            ]),
          )
        : json(page([makeTestResult(1, { status: 'failed', name: 'rounds half up' }), makeTestResult(2, { name: 'sums lines' })])),
    );
    const { user } = renderTests();

    const summary = await screen.findByText('invoice › InvoiceTotals › rounds half up');
    expect(http.calls('GET', RESULTS_PATH)[0]?.search.get('status')).toBe('failed');
    const details = summary.closest('details');
    expect(details).not.toHaveAttribute('open');
    await user.click(summary);
    expect(details).toHaveAttribute('open');
    expect(within(details as HTMLElement).getByText('AssertionError')).toBeInTheDocument();
    expect(within(details as HTMLElement).getByText('expected 10.01 to equal 10.00')).toBeInTheDocument();
    expect(within(details as HTMLElement).getByText('at invoice.test.ts:42:7')).toBeInTheDocument();
    expect(screen.queryByText('invoice › InvoiceTotals › sums lines')).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText(/Show/), '');
    expect(await screen.findByText('invoice › InvoiceTotals › sums lines')).toBeInTheDocument();
    expect(http.calls('GET', RESULTS_PATH).at(-1)?.search.has('status')).toBe(false);
  });

  it('says that no test command is configured when there are no runs', async () => {
    http.on('GET', `${TASK_PATH}/tests`, json([]));
    http.on('GET', `/api/v1/projects/${IDS.project}`, json(makeProject({ testCommand: null, junitReportPath: null })));
    renderTests();

    expect(await screen.findByText('No test command configured for this project, so no tests were run.')).toBeInTheDocument();
  });

  it('says that no runs were recorded when the project has a test command', async () => {
    http.on('GET', `${TASK_PATH}/tests`, json([]));
    renderTests();

    expect(await screen.findByText('No test runs were recorded for this attempt.')).toBeInTheDocument();
  });

  it('shows a report parse error and the unparsed empty state', async () => {
    http.on(
      'GET',
      `${TASK_PATH}/tests`,
      json([
        makeTestRun({
          status: 'error',
          failed: 0,
          passed: 0,
          total: 0,
          skipped: 0,
          reportParsed: false,
          reportError: 'junit.xml not found',
        }),
      ]),
    );
    http.on('GET', RESULTS_PATH, json(page([])));
    renderTests();

    expect(await screen.findByText('JUnit report could not be parsed')).toBeInTheDocument();
    expect(screen.getByText('junit.xml not found')).toBeInTheDocument();
    expect(await screen.findByText('No JUnit report was parsed for this run.')).toBeInTheDocument();
  });

  it('shows the Problem details when the runs cannot be loaded', async () => {
    http.on('GET', `${TASK_PATH}/tests`, problem(503, 'service_unavailable', 'Service unavailable', {}, { 'Retry-After': '5' }));
    renderTests();

    expect(await screen.findByText('Service unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry in [45] s/ })).toBeDisabled();
  });
});

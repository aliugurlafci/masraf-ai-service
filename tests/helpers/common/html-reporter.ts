// Vitest reporter used by `npm run test:report` (contract §18.1, F19, requirements §5.9).
// Vitest 5 takes the HTML report location only from the `html` reporter's `outputDir` option,
// which the CLI cannot set (`--outputFile.html` is ignored). test-report.ts therefore passes
// this module as a CLI reporter and names the per-project directory in HTML_REPORT_DIR_ENV.
import HTMLReporterModule from '@vitest/ui/reporter';
import type { Reporter } from 'vitest/node';

/** Environment variable that carries the repo-relative output directory of one HTML report. */
export const HTML_REPORT_DIR_ENV = 'ORC_TEST_REPORT_HTML_DIR';

interface HtmlReporterOptions {
  outputDir: string;
  singleFile?: boolean;
}

// The published typings declare a reporter instance; the runtime default export is the class.
const HTMLReporter = HTMLReporterModule as unknown as new (options: HtmlReporterOptions) => Reporter;

export function htmlReportDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env[HTML_REPORT_DIR_ENV];
  if (!dir || dir.trim() === '') {
    throw new Error(`html-reporter: ${HTML_REPORT_DIR_ENV} must name the report directory`);
  }
  return dir;
}

export default class TestReportHtmlReporter extends HTMLReporter {
  constructor() {
    super({ outputDir: htmlReportDirFromEnv() });
  }
}

// JUnit report parsing (§13.5): counts, statuses, nested suites, entity handling, DTD rejection, case cap.
import { describe, expect, it } from 'vitest';
import { OrcError } from '@orc/shared';
import { parseJUnitXml } from '@orc/orchestrator';

const REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="all" tests="5">
  <testsuite name="math" tests="3" file="test/math.test.js">
    <testcase classname="math" name="adds" time="0.012"/>
    <testcase classname="math" name="divides &amp; rounds" time="1.5">
      <failure message="expected 2 &lt; 1" type="AssertionError">at math.test.js:10</failure>
    </testcase>
    <testcase classname="math" name="skipped one"><skipped/></testcase>
  </testsuite>
  <testsuite name="io" tests="2">
    <testsuite name="io.nested">
      <testcase classname="io" name="reads" file="test/io.test.js"/>
      <testcase classname="io" name="crashes"><error message="ENOENT" type="Error">stack &#x41;</error></testcase>
    </testsuite>
  </testsuite>
</testsuites>`;

describe('parseJUnitXml', () => {
  it('parses cases, statuses, durations and failure details', () => {
    const r = parseJUnitXml(REPORT, { maxCases: 5000 });
    expect(r.counts).toEqual({ total: 5, passed: 2, failed: 1, errored: 1, skipped: 1 });
    expect(r.truncated).toBe(false);
    const byName = new Map(r.cases.map((c) => [c.name, c]));
    expect(byName.get('adds')).toMatchObject({ suiteName: 'math', className: 'math', status: 'passed', durationMs: 12, filePath: 'test/math.test.js' });
    expect(byName.get('divides & rounds')).toMatchObject({
      status: 'failed',
      durationMs: 1500,
      failureType: 'AssertionError',
      failureMessage: 'expected 2 < 1',
      failureDetail: 'at math.test.js:10',
    });
    expect(byName.get('skipped one')?.status).toBe('skipped');
    expect(byName.get('reads')).toMatchObject({ suiteName: 'io.nested', filePath: 'test/io.test.js', status: 'passed' });
    expect(byName.get('crashes')).toMatchObject({ status: 'error', failureMessage: 'ENOENT', failureDetail: 'stack A' });
  });

  it('accepts a single <testsuite> root', () => {
    const r = parseJUnitXml('<testsuite name="s"><testcase name="t"/></testsuite>', { maxCases: 10 });
    expect(r.counts.total).toBe(1);
    expect(r.cases[0]?.suiteName).toBe('s');
  });

  it('caps the stored cases but keeps full counts', () => {
    const cases = Array.from({ length: 7 }, (_, i) => `<testcase name="t${i}"/>`).join('');
    const r = parseJUnitXml(`<testsuites><testsuite name="s">${cases}</testsuite></testsuites>`, { maxCases: 3 });
    expect(r.cases).toHaveLength(3);
    expect(r.counts.total).toBe(7);
    expect(r.truncated).toBe(true);
  });

  it('rejects DTDs / entity declarations (no expansion)', () => {
    const bomb = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><testsuite><testcase name="&a;"/></testsuite>';
    expect(() => parseJUnitXml(bomb, { maxCases: 10 })).toThrow(OrcError);
    try {
      parseJUnitXml(bomb, { maxCases: 10 });
    } catch (e) {
      expect((e as OrcError).code).toBe('junit_invalid');
    }
  });

  it("parses Node's junit reporter: top-level <testcase> directly under <testsuites> next to nested suites", () => {
    const xml = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<testsuites>',
      '\t<testcase name="top passes" time="0.001" classname="test" file="/w/test/a.test.mjs"/>',
      '\t<testcase name="top fails" time="0.002" classname="test" file="/w/test/a.test.mjs">',
      '\t\t<failure type="testCodeFailure" message="REACHABLE: TCP mssql:1433">AssertionError</failure>',
      '\t</testcase>',
      '\t<testsuite name="group" time="0.003" disabled="0" errors="0" tests="1" failures="0" skipped="0" hostname="h">',
      '\t\t<testcase name="nested" time="0.001" classname="test"/>',
      '\t</testsuite>',
      '</testsuites>',
    ].join('\n');
    const r = parseJUnitXml(xml, { maxCases: 10 });
    expect(r.counts).toEqual({ total: 3, passed: 2, failed: 1, errored: 0, skipped: 0 });
    expect(r.cases.map((c) => [c.name, c.status, c.suiteName])).toEqual([
      ['top passes', 'passed', null],
      ['top fails', 'failed', null],
      ['nested', 'passed', 'group'],
    ]);
    expect(r.cases[1]?.failureMessage).toBe('REACHABLE: TCP mssql:1433');
    expect(r.cases[0]?.filePath).toBe('/w/test/a.test.mjs');
  });

  it('rejects malformed XML and foreign roots', () => {
    expect(() => parseJUnitXml('<testsuite><testcase></testsuite>', { maxCases: 10 })).toThrow(/well-formed/);
    expect(() => parseJUnitXml('<report/>', { maxCases: 10 })).toThrow(/no <testsuites>/);
  });
});

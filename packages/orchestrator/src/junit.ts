// JUnit XML report parsing (contract §13.5): fast-xml-parser without entity processing or DTDs.
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { OrcError } from '@orc/shared';
import type { TestCaseStatus } from '@orc/shared';
import type { ParsedJUnit } from './types.js';

type XmlNode = Record<string, unknown>;

const NAME_MAX = 1000;
const MESSAGE_MAX = 4000;
const DETAIL_MAX = 16_000;
const FILE_MAX = 1000;

const ENTITY_RE = /&(lt|gt|amp|quot|apos|#\d{1,7}|#x[0-9a-fA-F]{1,6});/g;

/** Decodes the predefined XML entities and numeric references only (no DTD-defined entities). */
function decodeEntities(s: string): string {
  return s.replace(ENTITY_RE, (m, name: string) => {
    switch (name) {
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'amp':
        return '&';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default: {
        const code = name.startsWith('#x') ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
      }
    }
  });
}

function clip(s: string | null, max: number): string | null {
  if (s === null) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function asNodes(v: unknown): XmlNode[] {
  if (v === undefined || v === null) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.map((x) => (typeof x === 'object' && x !== null ? (x as XmlNode) : { '#text': String(x) }));
}

function attr(n: XmlNode, name: string): string | null {
  const v = n[`@_${name}`];
  if (typeof v === 'string') return decodeEntities(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

function text(n: XmlNode): string | null {
  const v = n['#text'];
  if (typeof v === 'string') return decodeEntities(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

function secondsToMs(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v.replace(/,/g, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(Math.round(n * 1000), 2_147_483_647);
}

function* suites(node: XmlNode, inherited: string | null): Generator<{ suite: XmlNode; name: string | null }> {
  for (const s of asNodes(node['testsuite'])) {
    const name = attr(s, 'name') ?? inherited;
    yield { suite: s, name };
    yield* suites(s, name);
  }
}

/** Parses a JUnit report into TestResults rows (<= maxCases) and counts. Throws OrcError('junit_invalid'). */
export function parseJUnitXml(xml: string, o: { maxCases: number }): ParsedJUnit {
  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) {
    throw new OrcError('junit_invalid', 'JUnit report must not contain a DTD');
  }
  const valid = XMLValidator.validate(xml);
  if (valid !== true) {
    throw new OrcError('junit_invalid', `JUnit report is not well-formed XML: ${valid.err.msg}`.slice(0, 500));
  }
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    processEntities: false,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    allowBooleanAttributes: true,
  });
  let doc: unknown;
  try {
    doc = parser.parse(xml);
  } catch (e) {
    throw new OrcError('junit_invalid', 'JUnit report could not be parsed', { cause: e });
  }
  if (typeof doc !== 'object' || doc === null) throw new OrcError('junit_invalid', 'JUnit report is empty');
  const root = doc as XmlNode;
  const top: XmlNode = {};
  if (root['testsuites'] !== undefined) {
    const containers = asNodes(root['testsuites']);
    // Node's built-in junit reporter writes top-level tests as <testcase> children of <testsuites>: they form a
    // suite of their own (named after the container, if any).
    top['testsuite'] = containers.flatMap((c) => [
      ...(c['testcase'] === undefined ? [] : [{ '@_name': c['@_name'], testcase: c['testcase'] } as XmlNode]),
      ...asNodes(c['testsuite']),
    ]);
  } else if (root['testsuite'] !== undefined) {
    top['testsuite'] = root['testsuite'];
  } else {
    throw new OrcError('junit_invalid', 'JUnit report has no <testsuites> or <testsuite> root');
  }

  const cases: ParsedJUnit['cases'] = [];
  const counts = { total: 0, passed: 0, failed: 0, errored: 0, skipped: 0 };
  let truncated = false;
  for (const { suite, name: suiteName } of suites(top, null)) {
    const suiteFile = attr(suite, 'file');
    for (const tc of asNodes(suite['testcase'])) {
      const failure = asNodes(tc['failure'])[0];
      const error = asNodes(tc['error'])[0];
      const skipped = tc['skipped'] !== undefined || tc['ignored'] !== undefined;
      let status: TestCaseStatus = 'passed';
      let detailNode: XmlNode | undefined;
      if (error) {
        status = 'error';
        detailNode = error;
      } else if (failure) {
        status = 'failed';
        detailNode = failure;
      } else if (skipped) {
        status = 'skipped';
      }
      counts.total += 1;
      if (status === 'passed') counts.passed += 1;
      else if (status === 'failed') counts.failed += 1;
      else if (status === 'error') counts.errored += 1;
      else counts.skipped += 1;
      if (cases.length >= o.maxCases) {
        truncated = true;
        continue;
      }
      cases.push({
        suiteName: clip(suiteName, NAME_MAX),
        className: clip(attr(tc, 'classname'), NAME_MAX),
        name: clip(attr(tc, 'name') ?? '(unnamed)', NAME_MAX) ?? '(unnamed)',
        filePath: clip(attr(tc, 'file') ?? suiteFile, FILE_MAX),
        status,
        durationMs: secondsToMs(attr(tc, 'time')),
        failureType: detailNode ? clip(attr(detailNode, 'type'), NAME_MAX) : null,
        failureMessage: detailNode ? clip(attr(detailNode, 'message'), MESSAGE_MAX) : null,
        failureDetail: detailNode ? clip(text(detailNode), DETAIL_MAX) : null,
      });
    }
  }
  return { cases, counts, truncated };
}

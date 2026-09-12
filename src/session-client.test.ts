import assert from 'node:assert/strict';
import test from 'node:test';
import { applyFullTextMatchMode, FamilySearchSessionClient } from './session-client.js';

test('applyFullTextMatchMode supports OR, AND, and exact phrase searches', () => {
  assert.equal(applyFullTextMatchMode('Ebel Hanses', 'any'), 'Ebel Hanses');
  assert.equal(applyFullTextMatchMode('Ebel Hanses', 'all'), '+Ebel +Hanses');
  assert.equal(applyFullTextMatchMode('Ebel Hanses', 'exact'), '"Ebel Hanses"');
  assert.equal(applyFullTextMatchMode('"Ebel Hanses"', 'exact'), '"Ebel Hanses"');
});

test('searchFullText maps filters and returns OCR metadata', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';

  globalThis.fetch = (async (input: string | URL | Request) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({
      results: 42,
      index: 10,
      links: { next: { href: 'https://example.test/next' } },
      entries: [{
        id: '3:1:TEST-ID',
        sourceUrl: 'https://www.familysearch.org/ark:/61903/3:1:TEST-ID',
        collectionId: 'COLLECTION-1',
        collectionTitle: 'Test collection',
        content: {
          title: 'Test document',
          recordDate: '1750',
          recordType: 'Court records',
          recordPlace: 'Leeuwarden',
          textDocument: 'Full OCR transcript',
          highlightTexts: ['Leeuwarden'],
          entities: [{ type: 'PLACE', value: 'Leeuwarden' }],
        },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    const client = new FamilySearchSessionClient({ cookies: 'session=test', minIntervalMs: 0, maxRetries: 0 });
    const result = await client.searchFullText({
      keywords: 'voogd',
      fullName: 'Jan de Vries',
      place: 'Leeuwarden',
      yearFrom: 1700,
      yearTo: 1800,
      imageGroupNumber: '008903222',
      collectionId: 'COLLECTION-1',
      limit: 5,
      offset: 10,
      matchMode: 'all',
    });

    const url = new URL(requestedUrl);
    assert.equal(url.pathname, '/service/search/fulltext/search');
    assert.equal(url.searchParams.get('q.text'), '+voogd');
    assert.equal(url.searchParams.get('q.fullName'), '+Jan +de +Vries');
    assert.equal(url.searchParams.get('q.anyPlace'), 'Leeuwarden');
    assert.equal(url.searchParams.get('q.anyDate.from'), '1700');
    assert.equal(url.searchParams.get('q.anyDate.to'), '1800');
    assert.equal(url.searchParams.get('q.groupName'), '008903222');
    assert.equal(url.searchParams.get('f.collectionId'), 'COLLECTION-1');
    assert.equal(url.searchParams.get('count'), '5');
    assert.equal(url.searchParams.get('offset'), '10');

    assert.equal(result.total, 42);
    assert.equal(result.offset, 10);
    assert.equal(result.entries[0]?.transcript, 'Full OCR transcript');
    assert.equal(result.entries[0]?.sourceUrl, 'https://www.familysearch.org/ark:/61903/3:1:TEST-ID');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('searchCatalog maps DGS searches and catalog metadata', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  globalThis.fetch = (async (input: string | URL | Request) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({
      totalHits: 1,
      offset: 0,
      searchHits: [{
        metadataHit: {
          score: 12,
          metadata: {
            identifier: { value: 'https://www.familysearch.org/service/search/catalog/item/koha:123' },
            title: [{ value: 'Test register' }],
            creator: [{ value: 'Test archive' }],
            subject: [{ value: 'Church records' }],
            coverage: [{ place: 'Leeuwarden', datesOrig: '1600-1700' }],
          },
        },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    const client = new FamilySearchSessionClient({ cookies: 'session=test', minIntervalMs: 0, maxRetries: 0 });
    const result = await client.searchCatalog({ filmNumber: '008903222', keywords: 'trouwregister', limit: 2 });
    const url = new URL(requestedUrl);
    assert.equal(url.pathname, '/service/search/catalog/v3/search');
    assert.equal(url.searchParams.get('q.filmNumber'), '8903222');
    assert.equal(url.searchParams.get('q.keywords'), 'trouwregister');
    assert.equal(url.searchParams.get('m.defaultFacets'), 'on');
    assert.equal(url.searchParams.get('m.queryRequireDefault'), 'on');
    assert.equal(result.total, 1);
    assert.equal(result.entries[0]?.title, 'Test register');
    assert.equal(result.entries[0]?.url, 'https://www.familysearch.org/en/search/catalog/koha:123');
    assert.deepEqual(result.entries[0]?.coverage, ['Leeuwarden; 1600-1700']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

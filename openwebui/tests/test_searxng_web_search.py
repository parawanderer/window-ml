"""What SearXNG Web Search reports while it works, and what it does with a bad request.

Its whole job is one HTTP call, so there is nothing here about streaming. What is worth pinning is
the reporting either side of that call: one citation per result so a client can render sources, a
terminal status whichever way it ends, and a failing instance producing an actionable sentence
rather than a traceback the model has to interpret.
"""

from __future__ import annotations

import unittest

import harness

requests = harness.install()
searxng = harness.load('searxng_web_search')

RESULTS = {
    'results': [
        {'title': 'Alpha', 'url': 'http://a.example', 'content': 'about alpha', 'engine': 'duckduckgo'},
        {'title': 'Beta', 'url': 'http://b.example', 'content': 'about beta',
         'publishedDate': '2026-01-02T00:00:00'},
    ]
}


class FakeSearch:
    def __init__(self, payload=RESULTS):
        self.payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self.payload


class Search(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.params = {}
        self.response = FakeSearch()

        def get(url, params=None, headers=None, timeout=None):
            self.params = params or {}
            if isinstance(self.response, Exception):
                raise self.response
            return self.response

        requests.get = get
        self.tool = searxng.Tools()
        self.recorder = harness.Recorder()

    async def test_one_citation_per_result_carrying_its_own_url(self):
        await self.tool.search_web('anything', __event_emitter__=self.recorder)
        citations = self.recorder.of_type('citation')
        self.assertEqual(len(citations), 2)
        self.assertEqual(
            [c['data']['metadata'][0]['source'] for c in citations],
            ['http://a.example', 'http://b.example'],
        )

    async def test_it_reports_starting_and_finishing(self):
        await self.tool.search_web('anything', __event_emitter__=self.recorder)
        descriptions = self.recorder.descriptions()
        self.assertTrue(descriptions[0].startswith('Searching the web for:'))
        self.assertTrue(self.recorder.events[-1]['data']['done'])
        self.assertEqual(self.recorder.events[-1]['data']['status'], 'success')

    async def test_no_results_still_ends_done(self):
        self.response = FakeSearch({'results': []})
        answer = await self.tool.search_web('anything', __event_emitter__=self.recorder)
        self.assertIn('No web results found', answer)
        self.assertTrue(self.recorder.events[-1]['data']['done'])

    async def test_a_failing_instance_explains_itself(self):
        self.response = RuntimeError('connection refused')
        answer = await self.tool.search_web('anything', __event_emitter__=self.recorder)
        # The model reads this string, so it has to name the fix rather than the exception.
        self.assertIn('connection refused', answer)
        self.assertIn('SEARXNG_URL', answer)
        self.assertEqual(self.recorder.events[-1]['data']['status'], 'error')

    async def test_an_unknown_category_never_reaches_the_instance(self):
        # SearXNG answers an unknown category with zero results rather than an error, which reads as
        # "nothing found" and sends the model looking for a different query.
        answer = await self.tool.search_web('anything', category='sport', __event_emitter__=self.recorder)
        self.assertEqual(self.params, {})
        self.assertIn('sport', answer)

    async def test_it_runs_without_an_emitter_at_all(self):
        # __event_emitter__ is None outside a chat session, and every emit has to tolerate that.
        self.assertIn('Alpha', await self.tool.search_web('anything'))


if __name__ == '__main__':
    unittest.main()

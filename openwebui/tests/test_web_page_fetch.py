"""The streaming contract of Web Page Fetch & Summarize.

The tool's value is that a minute of a local model generating is reported as it happens rather than
as silence followed by everything at once, so what is asserted here is the emitting: that each token
goes out in order, that the answer is identical whether or not anyone is listening, and that the
streaming path is not a second way to get a different result.
"""

from __future__ import annotations

import asyncio
import json
import unittest

import harness

requests = harness.install()
web_page_fetch = harness.load('web_page_fetch')

TOKENS = ['Adaptive ', 'bitrate ', 'streaming ', 'switches ', 'quality.']


def sse_lines(tokens):
    """The SSE body an OpenAI-shaped backend sends, with two frames a client must survive."""
    for token in tokens:
        yield 'data: ' + json.dumps({'choices': [{'delta': {'content': token}}]})
    yield ''                          # keep-alive blank line
    yield 'data: {"choices":[]}'      # a frame with no delta at all
    yield 'data: [DONE]'


class FakeCompletion:
    def __init__(self, tokens=TOKENS):
        self.tokens = tokens

    def raise_for_status(self):
        pass

    def json(self):
        return {'choices': [{'message': {'content': ''.join(self.tokens)}}]}

    def iter_lines(self, decode_unicode=True):
        return iter(sse_lines(self.tokens))


class StreamingSummary(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.posted = {}

        def post(url, headers=None, json=None, timeout=None, stream=False):
            self.posted['body'] = json
            self.posted['transport_stream'] = stream
            return self.completion

        self.completion = FakeCompletion()
        requests.post = post

        self.tool = web_page_fetch.Tools()
        self.tool.valves = web_page_fetch.Tools.Valves(
            API_KEY='k', OPENWEBUI_URL='http://owui', SUMMARY_MODEL='m', SUMMARY_TIMEOUT=5
        )

    async def summarize(self, on_delta=None):
        # Called off the loop exactly as the tool calls it, so the thread hop is under test too.
        return await asyncio.to_thread(
            self.tool._summarize, 'http://a', 'A', 'page text', 'what is it', False, on_delta
        )

    def delta_sink(self):
        seen = []
        loop = asyncio.get_running_loop()

        async def record(delta):
            seen.append(delta)

        return seen, lambda delta: asyncio.run_coroutine_threadsafe(record(delta), loop).result()

    async def test_every_token_is_emitted_in_order(self):
        seen, on_delta = self.delta_sink()
        await self.summarize(on_delta)
        self.assertEqual(seen, TOKENS)

    async def test_streaming_is_requested_of_both_body_and_transport(self):
        _, on_delta = self.delta_sink()
        await self.summarize(on_delta)
        self.assertIs(self.posted['body']['stream'], True)
        self.assertIs(self.posted['transport_stream'], True)

    async def test_without_a_sink_nothing_streams(self):
        await self.summarize(None)
        self.assertIs(self.posted['body']['stream'], False)
        self.assertIs(self.posted['transport_stream'], False)

    async def test_the_answer_is_the_same_either_way(self):
        _, on_delta = self.delta_sink()
        self.assertEqual(await self.summarize(on_delta), await self.summarize(None))

    async def test_a_frame_without_a_delta_is_skipped_not_fatal(self):
        # sse_lines emits a blank line and a delta-less frame before [DONE]; reaching the end with
        # the whole answer is the assertion.
        seen, on_delta = self.delta_sink()
        self.assertEqual(await self.summarize(on_delta), ''.join(TOKENS).strip())
        self.assertEqual(seen, TOKENS)

    async def test_an_empty_stream_is_still_an_error(self):
        self.completion = FakeCompletion(tokens=[])
        _, on_delta = self.delta_sink()
        with self.assertRaises(ValueError) as caught:
            await self.summarize(on_delta)
        self.assertIn('empty response', str(caught.exception))


if __name__ == '__main__':
    unittest.main()

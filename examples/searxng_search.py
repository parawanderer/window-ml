"""
title: SearXNG Web Search

author: window.ml
git_url: https://github.com/parawanderer/window-ml

description: Query a self-hosted SearXNG instance and return the top web results. Unlike OpenWebUI's built-in "Web Search" (which only runs in the UI's agent loop), this is a workspace Tool, so it executes over the external /api/chat/completions API too — i.e. it works from window.ml / other API clients (open-webui issue #12045).

requirements: requests

version: 0.1.0

license: MIT
"""

from __future__ import annotations

from typing import Any, Callable

import requests
from pydantic import BaseModel, Field


class Tools:
    class Valves(BaseModel):
        SEARXNG_URL: str = Field(
            default="http://searxng:8080/search",
            description=(
                "Your SearXNG search endpoint. It must have JSON output enabled "
                "(search.formats in settings.yml includes 'json')."
            ),
        )
        MAX_RESULTS: int = Field(
            default=5, description="Maximum number of results to return."
        )
        TIMEOUT: int = Field(default=15, description="HTTP request timeout, seconds.")

    def __init__(self):
        self.valves = self.Valves()

    async def search_web(
        self,
        query: str,
        __event_emitter__: Callable[[dict], Any] | None = None,
    ) -> str:
        """
        Search the web via SearXNG and return the top results (title, URL, snippet).
        Use this to find information that is not in the current page or transcript —
        e.g. background on a person, channel, or product, or to verify a claim.
        :param query: The search query.
        :return: A formatted list of the top results, or an error message.
        """

        async def emit(description: str, status: str = "in_progress", done: bool = False):
            if __event_emitter__:
                await __event_emitter__(
                    {
                        "type": "status",
                        "data": {"description": description, "status": status, "done": done},
                    }
                )

        await emit(f"Searching the web for: {query}")
        try:
            resp = requests.get(
                self.valves.SEARXNG_URL,
                params={"q": query, "format": "json"},
                headers={"User-Agent": "OpenWebUI-SearXNG-Tool"},
                timeout=self.valves.TIMEOUT,
            )
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            await emit(f"Web search failed: {e}", "error", True)
            return (
                f"Web search failed: {e}. Check the SEARXNG_URL valve and that SearXNG "
                f"has JSON output enabled (search.formats includes 'json')."
            )

        results = (data.get("results") or [])[: self.valves.MAX_RESULTS]
        if not results:
            await emit("No results found.", "success", True)
            return f"No web results found for: {query}"

        lines = []
        for i, r in enumerate(results, 1):
            title = (r.get("title") or "").strip()
            url = (r.get("url") or "").strip()
            snippet = (r.get("content") or "").strip()
            lines.append(f"{i}. {title}\n{url}\n{snippet}")

        await emit(f"Found {len(results)} result(s).", "success", True)
        return "Web search results:\n\n" + "\n\n".join(lines)
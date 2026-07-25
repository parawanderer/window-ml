"""
title: SearXNG Web Search

author: window.ml
git_url: https://github.com/parawanderer/window-ml

description: Query a self-hosted SearXNG instance and return the top web results. Unlike OpenWebUI's built-in "Web Search" (which only runs in the UI's agent loop), this is a workspace Tool, so it executes over the external /api/chat/completions API too — i.e. it works from window.ml / other API clients (open-webui issue #12045). Pairs with the "Web Page Fetch & Summarize" tool for drilling into a specific result.

requirements: requests

version: 0.2.0

license: MIT
"""

from __future__ import annotations

import asyncio
from typing import Any, Callable

import requests
from pydantic import BaseModel, Field

# SearXNG's own category names. Anything not in here is rejected before we
# hit the instance, because SearXNG silently returns zero results for an
# unknown category rather than erroring — which looks like "nothing found".
VALID_CATEGORIES = {
    "general",
    "news",
    "images",
    "videos",
    "music",
    "science",
    "it",
    "files",
    "social media",
    "map",
}

VALID_TIME_RANGES = {"day", "week", "month", "year"}


class Tools:
    class Valves(BaseModel):
        SEARXNG_URL: str = Field(
            default="http://searxng:8080/search",
            description=(
                "Your SearXNG search endpoint. It must have JSON output enabled "
                "(search.formats in settings.yml includes 'json')."
            ),
        )
        DEFAULT_RESULTS: int = Field(
            default=5,
            description="Results returned when the model does not ask for a specific count.",
        )
        MAX_RESULTS: int = Field(
            default=20,
            description="Hard cap on results per call, regardless of what the model asks for.",
        )
        DEFAULT_LANGUAGE: str = Field(
            default="auto",
            description="Default search language, e.g. 'auto', 'en', 'en-GB', 'de'.",
        )
        SAFESEARCH: int = Field(
            default=0, description="SearXNG safesearch level: 0 off, 1 moderate, 2 strict."
        )
        ENGINES: str = Field(
            default="",
            description=(
                "Optional comma-separated engine restriction applied to every search "
                "(e.g. 'google,duckduckgo,brave'). Empty means use the instance defaults."
            ),
        )
        SUGGEST_DEEP_DIVE: bool = Field(
            default=True,
            description=(
                "Append a hint telling the model it can drill into a result with the "
                "web page fetch/summarize tool."
            ),
        )
        TIMEOUT: int = Field(default=15, description="HTTP request timeout, seconds.")

    def __init__(self):
        self.valves = self.Valves()

    async def search_web(
        self,
        query: str,
        num_results: int = 0,
        category: str = "general",
        time_range: str = "",
        language: str = "",
        page: int = 1,
        __event_emitter__: Callable[[dict], Any] | None = None,
    ) -> str:
        """
        Search the web via SearXNG and return ranked results (title, URL, snippet).
        This returns short snippets only — it is the cheap, wide step. To read what a
        result actually says, follow up with the web page fetch/summarize tool on the
        specific URL you care about.
        :param query: The search query. Plain keywords work best; SearXNG also supports
            bang syntax like "!news" or site filters like "site:example.com".
        :param num_results: How many results to return. 0 uses the configured default.
            Ask for more (10-20) when surveying a topic, fewer (3) for a quick fact check.
        :param category: Which SearXNG category to search. One of: general, news, images,
            videos, music, science, it, files, social media, map. Use "news" for current
            events, "science" for papers, "it" for programming/technical sources.
        :param time_range: Restrict results by recency. One of "day", "week", "month",
            "year", or empty for no restriction. Use this for anything time-sensitive.
        :param language: Result language code, e.g. "en", "en-GB", "de". Empty uses the
            configured default.
        :param page: Result page number, starting at 1. Use 2, 3, ... to get further
            results for the same query instead of re-running it.
        :return: A formatted list of results, or an error message.
        """

        async def emit(
            description: str, status: str = "in_progress", done: bool = False
        ):
            if __event_emitter__:
                await __event_emitter__(
                    {
                        "type": "status",
                        "data": {
                            "description": description,
                            "status": status,
                            "done": done,
                        },
                    }
                )

        async def cite(title: str, url: str, snippet: str):
            # One citation per result → each becomes its own source with a real
            # URL, so clients (and the UI) can render individual clickable chips
            # instead of one opaque tool-output blob.
            if __event_emitter__ and url:
                await __event_emitter__(
                    {
                        "type": "citation",
                        "data": {
                            "document": [snippet or title or url],
                            "metadata": [{"source": url}],
                            "source": {"name": title or url},
                        },
                    }
                )

        query = (query or "").strip()
        if not query:
            return "Web search failed: the query was empty."

        category = (category or "general").strip().lower()
        if category not in VALID_CATEGORIES:
            return (
                f"Unknown category '{category}'. Valid categories: "
                f"{', '.join(sorted(VALID_CATEGORIES))}."
            )

        time_range = (time_range or "").strip().lower()
        if time_range and time_range not in VALID_TIME_RANGES:
            return (
                f"Unknown time_range '{time_range}'. Valid values: "
                f"{', '.join(sorted(VALID_TIME_RANGES))}, or omit it."
            )

        limit = num_results if num_results > 0 else self.valves.DEFAULT_RESULTS
        limit = max(1, min(limit, self.valves.MAX_RESULTS))
        page = max(1, page)

        params: dict[str, Any] = {
            "q": query,
            "format": "json",
            "categories": category,
            "pageno": page,
            "safesearch": self.valves.SAFESEARCH,
            "language": (language or self.valves.DEFAULT_LANGUAGE).strip(),
        }
        if time_range:
            params["time_range"] = time_range
        if self.valves.ENGINES.strip():
            params["engines"] = self.valves.ENGINES.strip()

        scope = category
        if time_range:
            scope += f", past {time_range}"
        if page > 1:
            scope += f", page {page}"
        await emit(f"Searching the web for: {query} ({scope})")

        try:
            # requests is blocking, and this runs on OpenWebUI's single uvicorn
            # event loop — calling it directly would stall the whole instance
            # until SearXNG answers or times out.
            resp = await asyncio.to_thread(
                requests.get,
                self.valves.SEARXNG_URL,
                params=params,
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

        results = (data.get("results") or [])[:limit]
        if not results:
            await emit("No results found.", "success", True)
            hint = ""
            if time_range or category != "general":
                hint = " Try widening the search: drop time_range or use category 'general'."
            return f"No web results found for: {query}.{hint}"

        lines = []
        for i, r in enumerate(results, 1):
            title = (r.get("title") or "").strip()
            url = (r.get("url") or "").strip()
            snippet = (r.get("content") or "").strip()
            published = (r.get("publishedDate") or "").strip()

            meta = []
            if published:
                meta.append(published[:10])
            engines = r.get("engines") or ([r["engine"]] if r.get("engine") else [])
            if engines:
                meta.append(", ".join(engines))
            suffix = f"\n[{' · '.join(meta)}]" if meta else ""

            lines.append(f"{i}. {title}\n{url}\n{snippet}{suffix}")
            await cite(title, url, snippet)

        await emit(f"Found {len(results)} result(s).", "success", True)

        out = "Web search results:\n\n" + "\n\n".join(lines)
        if self.valves.SUGGEST_DEEP_DIVE:
            out += (
                "\n\n---\n"
                "These are snippets only — often truncated, stale, or a third party's "
                "paraphrase. Use the web page fetch/summarize tool to read what a result "
                "actually says, choosing how widely to read based on the question:\n"
                "- If one source authoritatively owns the answer (official docs, a spec, "
                "a vendor's own pricing or changelog page, the paper or repo itself), "
                "fetch that one and trust it. Reading commentary about it adds noise, "
                "not confidence.\n"
                "- Otherwise — news, comparisons, recommendations, anything disputed or "
                "fast-moving — fetch the 2-4 most promising results and cross-check them. "
                "You can call the fetch tool several times in one turn.\n"
                "If a fetched page turns out not to answer the question, move on to the "
                "next candidate rather than falling back to its snippet. Never answer "
                "from snippets alone when precision matters (numbers, quotes, dates, "
                "versions, API details)."
            )
            if len(results) == limit:
                out += f" More results are available on page {page + 1}."
        return out

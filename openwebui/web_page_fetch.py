"""
title: Web Page Fetch & Summarize

author: window.ml
git_url: https://github.com/parawanderer/window-ml

description: Fetch a single web page, strip it to readable text, and (by default) compress it against a focused question using a cheap local model before it ever reaches the calling model's context. The deep-dive half of the search/fetch pair — use it on URLs returned by the SearXNG Web Search tool.

requirements: requests, trafilatura, beautifulsoup4

version: 0.1.0

license: MIT
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from typing import Any, Callable
from urllib.parse import urlparse

import requests
from pydantic import BaseModel, Field

try:
    import trafilatura
except ImportError:  # pragma: no cover - optional at runtime
    trafilatura = None

try:
    from bs4 import BeautifulSoup
except ImportError:  # pragma: no cover - optional at runtime
    BeautifulSoup = None

# Browser-ish UA. A surprising number of sites 403 anything that self-identifies
# as a bot, and we are fetching one page on a human's behalf, not crawling.
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0 Safari/537.36"
)

SUMMARY_SYSTEM_PROMPT = """You are a page-reading assistant. You are given the text of a single web page and a specific question from another AI agent. Extract what the page actually says about that question.

Rules:
- Answer only from the page text. Never add outside knowledge.
- If the page does not address the question, say so plainly in one line, then give a 2-3 sentence summary of what the page IS about.
- Preserve exact figures, dates, names, versions, prices and quotes verbatim. These are the whole point; never round or paraphrase them.
- Quote short critical passages directly, in quotation marks.
- No preamble, no "the page says that", no closing summary. Lead with the answer.
- Plain prose or short bullets. Be dense."""


class Tools:
    class Valves(BaseModel):
        OPENWEBUI_URL: str = Field(
            default="http://localhost:8080",
            description=(
                "Base URL of your OpenWebUI instance (no trailing /api). Used to call "
                "the summarizer model. From inside the OpenWebUI container this is "
                "usually http://localhost:8080."
            ),
        )
        API_KEY: str = Field(
            default="",
            description=(
                "OpenWebUI API key used to invoke the summarizer model "
                "(Settings → Account → API Keys). Required for summary mode."
            ),
        )
        SUMMARY_MODEL: str = Field(
            default="gemma4:31b",
            description=(
                "Model id used to compress fetched pages. Should be a fast local model. "
                "Must match the id exactly as OpenWebUI lists it."
            ),
        )
        MAX_PAGE_CHARS: int = Field(
            default=60000,
            description=(
                "Page text is truncated to this many characters before summarization, "
                "to stay inside the summarizer's context window."
            ),
        )
        MAX_RAW_CHARS: int = Field(
            default=12000,
            description="Character cap on what raw mode returns to the calling model.",
        )
        FETCH_TIMEOUT: int = Field(
            default=20, description="Page fetch timeout, seconds."
        )
        SUMMARY_TIMEOUT: int = Field(
            default=180,
            description="Summarizer model timeout, seconds. Local models can be slow.",
        )
        ALLOW_PRIVATE_HOSTS: bool = Field(
            default=False,
            description=(
                "Allow fetching localhost / private-network addresses. Leave off unless "
                "you specifically want the model reaching internal services."
            ),
        )

    def __init__(self):
        self.valves = self.Valves()

    async def fetch_page(
        self,
        url: str,
        query: str,
        mode: str = "summary",
        __event_emitter__: Callable[[dict], Any] | None = None,
    ) -> str:
        """
        Fetch one web page and read it against a specific question. This is the deep-dive
        step after a web search: pass a URL from the search results plus what you actually
        want to know, and get back only the relevant content instead of the whole page.
        Each call reads exactly one URL, and the result is compressed before it reaches
        you, so calling this several times in a turn is cheap — do that whenever the
        answer is spread across sources or worth cross-checking. When a single
        authoritative source owns the answer (official docs, a spec, the vendor's own
        page), one call to that source is enough.
        :param url: The full http(s) URL of the page to read.
        :param query: The specific question to answer from this page, e.g. "what pricing
            tiers are listed and what does each cost?". Be precise — everything not
            relevant to this question is discarded, so a vague query wastes the fetch.
        :param mode: "summary" (default) compresses the page against your query using a
            fast local model — use this almost always. "raw" returns the page's cleaned
            text verbatim, truncated; use it only when exact wording matters and the page
            is short, e.g. code samples, API reference tables, or legal/quoted text.
        :return: The extracted answer or raw page text, or an error message.
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

        url = (url or "").strip()
        mode = (mode or "summary").strip().lower()
        if mode not in ("summary", "raw"):
            mode = "summary"

        # Everything below that touches the network is blocking (requests, DNS).
        # OpenWebUI's backend is one uvicorn event loop, so calling it directly
        # here would freeze the whole instance — every user, every chat — for the
        # length of the fetch plus the summarization. Keep it all off the loop.
        blocked = await asyncio.to_thread(self._reject_url, url)
        if blocked:
            await emit(blocked, "error", True)
            return blocked

        host = urlparse(url).netloc
        await emit(f"Fetching {host}")

        try:
            text, title = await asyncio.to_thread(self._fetch_text, url)
        except Exception as e:
            await emit(f"Fetch failed: {e}", "error", True)
            return (
                f"Could not fetch {url}: {e}. The page may be paywalled, bot-blocked, "
                f"or offline — try a different result from the search."
            )

        if not text:
            await emit("No readable text found.", "error", True)
            return (
                f"Fetched {url} but found no readable text. It is likely a JavaScript-only "
                f"app, a PDF/binary, or a login wall. Try a different result."
            )

        await self._cite(__event_emitter__, title or url, url, text[:500])

        if mode == "raw":
            truncated = len(text) > self.valves.MAX_RAW_CHARS
            body = text[: self.valves.MAX_RAW_CHARS]
            await emit(f"Read {host} ({len(text):,} chars).", "success", True)
            note = (
                "\n\n[Truncated. Re-run with mode=\"summary\" to get the whole page "
                "compressed against your question.]"
                if truncated
                else ""
            )
            return f"Raw text of {url}\nTitle: {title or '(none)'}\n\n{body}{note}"

        if not self.valves.API_KEY.strip():
            return (
                "Summarization is not configured: set the API_KEY valve on this tool to an "
                "OpenWebUI API key. You can use mode=\"raw\" in the meantime."
            )

        page = text[: self.valves.MAX_PAGE_CHARS]
        clipped = len(text) > self.valves.MAX_PAGE_CHARS

        await emit(f"Reading {host} with {self.valves.SUMMARY_MODEL}")
        try:
            answer = await asyncio.to_thread(
                self._summarize, url, title, page, query, clipped
            )
        except Exception as e:
            await emit(f"Summarization failed: {e}", "error", True)
            return (
                f"Fetched {url} but the summarizer model failed: {e}. Check the "
                f"SUMMARY_MODEL, OPENWEBUI_URL and API_KEY valves. You can retry with "
                f"mode=\"raw\" to get the text directly."
            )

        await emit(f"Read {host}.", "success", True)
        header = f"Read: {title or url}\nSource: {url}"
        if clipped:
            header += (
                f"\nNote: only the first {self.valves.MAX_PAGE_CHARS:,} characters of the "
                f"page were read."
            )
        return f"{header}\n\n{answer}"

    # --- internals ---------------------------------------------------------

    def _reject_url(self, url: str) -> str | None:
        """Return an error string if the URL must not be fetched, else None."""
        if not url:
            return "No URL provided."

        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https"):
            return f"Refusing to fetch '{url}': only http and https URLs are supported."
        if not parsed.hostname:
            return f"Refusing to fetch '{url}': no hostname."

        if self.valves.ALLOW_PRIVATE_HOSTS:
            return None

        # Resolve first: "internal.corp" and "127.0.0.1.nip.io" both look public
        # by name but land on private space.
        try:
            infos = socket.getaddrinfo(parsed.hostname, None)
        except socket.gaierror as e:
            return f"Could not resolve {parsed.hostname}: {e}"

        for info in infos:
            ip = ipaddress.ip_address(info[4][0])
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
                return (
                    f"Refusing to fetch {parsed.hostname}: it resolves to a private or "
                    f"loopback address. Enable the ALLOW_PRIVATE_HOSTS valve if this is "
                    f"intended."
                )
        return None

    def _fetch_text(self, url: str) -> tuple[str, str]:
        """Fetch the URL and return (clean text, title)."""
        resp = requests.get(
            url,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
            },
            timeout=self.valves.FETCH_TIMEOUT,
        )
        resp.raise_for_status()

        content_type = resp.headers.get("content-type", "").lower()
        if "html" not in content_type:
            if content_type.startswith("text/") or "json" in content_type:
                return resp.text.strip(), url
            raise ValueError(
                f"unsupported content type '{content_type.split(';')[0]}' "
                f"(only HTML and plain text are readable)"
            )

        html = resp.text
        title = ""

        # trafilatura is the good path: it drops nav, ads, cookie banners and
        # comment sections, which is most of the token weight on a modern page.
        if trafilatura is not None:
            extracted = trafilatura.extract(
                html,
                include_comments=False,
                include_tables=True,
                favor_precision=True,
                url=url,
            )
            meta = trafilatura.extract_metadata(html)
            if meta and meta.title:
                title = meta.title
            if extracted and extracted.strip():
                return extracted.strip(), title

        # Fallback: strip tags ourselves. Noisier, but better than nothing when
        # trafilatura bails on an unusual layout.
        if BeautifulSoup is not None:
            soup = BeautifulSoup(html, "html.parser")
            for tag in soup(
                ["script", "style", "nav", "footer", "header", "aside", "form", "noscript"]
            ):
                tag.decompose()
            if not title and soup.title and soup.title.string:
                title = soup.title.string.strip()
            lines = [ln.strip() for ln in soup.get_text("\n").splitlines()]
            return "\n".join(ln for ln in lines if ln), title

        raise RuntimeError(
            "neither trafilatura nor beautifulsoup4 is installed; add them to the "
            "tool's requirements"
        )

    def _summarize(
        self, url: str, title: str, page: str, query: str, clipped: bool
    ) -> str:
        user_prompt = (
            f"QUESTION: {query.strip() or 'Summarize the key points of this page.'}\n\n"
            f"PAGE URL: {url}\n"
            f"PAGE TITLE: {title or '(unknown)'}\n"
            f"{'NOTE: the page text below is truncated.' if clipped else ''}\n\n"
            f"PAGE TEXT:\n\"\"\"\n{page}\n\"\"\""
        )

        resp = requests.post(
            f"{self.valves.OPENWEBUI_URL.rstrip('/')}/api/chat/completions",
            headers={
                "Authorization": f"Bearer {self.valves.API_KEY.strip()}",
                "Content-Type": "application/json",
            },
            json={
                "model": self.valves.SUMMARY_MODEL,
                "messages": [
                    {"role": "system", "content": SUMMARY_SYSTEM_PROMPT},
                    {"role": "user", "content": user_prompt},
                ],
                "stream": False,
                "temperature": 0.1,
            },
            timeout=self.valves.SUMMARY_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()

        try:
            content = data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError):
            raise ValueError(f"unexpected response shape: {str(data)[:300]}")

        content = (content or "").strip()
        if not content:
            raise ValueError("the summarizer returned an empty response")
        return content

    @staticmethod
    async def _cite(
        emitter: Callable[[dict], Any] | None, title: str, url: str, excerpt: str
    ):
        if emitter and url:
            await emitter(
                {
                    "type": "citation",
                    "data": {
                        "document": [excerpt or title or url],
                        "metadata": [{"source": url}],
                        "source": {"name": title or url},
                    },
                }
            )
